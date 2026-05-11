#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  repoRoot,
  siblingDefaults,
  resolveRepoPath,
  ensureRepoExists,
} = require('./workspace_paths');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return NaN;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function summarize(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) {
    return { n: 0, mean: null, stddev: null, median: null, p95: null, min: null, max: null };
  }
  const sorted = filtered.slice().sort((left, right) => left - right);
  const avg = mean(sorted);
  const variance = sorted.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / sorted.length;
  return {
    n: sorted.length,
    mean: Number(avg.toFixed(3)),
    stddev: Number(Math.sqrt(variance).toFixed(3)),
    median: Number(percentile(sorted, 50).toFixed(3)),
    p95: Number(percentile(sorted, 95).toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

function parseUmaChallenge(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) {
    throw new Error('Missing WWW-Authenticate header');
  }

  const headerWithoutScheme = wwwAuthenticateHeader.replace(/^UMA\s+/i, '');
  const params = Object.fromEntries(
    headerWithoutScheme.split(/\s*,\s*/).map((param) => {
      const separatorIndex = param.indexOf('=');
      if (separatorIndex < 0) return [param.trim(), ''];
      const key = param.slice(0, separatorIndex).trim();
      const value = param.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '');
      return [key, value];
    })
  );

  if (!params.ticket || !params.as_uri) {
    throw new Error(`Invalid UMA WWW-Authenticate header: ${wwwAuthenticateHeader}`);
  }

  const tokenEndpoint = new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString();
  return { tokenEndpoint, ticket: params.ticket };
}

function createOutputDir(runId) {
  const outputDir = path.join(repoRoot, 'benchmark-results', `protected-alert-access-${runId}`);
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function logCommandResult(logFile, command, args, result) {
  const lines = [
    `$ ${[command, ...args].join(' ')}`,
    result.stdout || '',
    result.stderr || '',
    `[process_exit] code=${result.status ?? 0}`,
    '',
  ];
  fs.appendFileSync(logFile, lines.join('\n'));
}

function runManagedPreflight(umaRepo, logFile) {
  const envVars = {
    ...process.env,
  };
  const verify = spawnSync('npm', ['run', 'verify:derived-alice'], {
    cwd: umaRepo,
    env: envVars,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  logCommandResult(logFile, 'npm', ['run', 'verify:derived-alice'], verify);
  if (verify.status !== 0) {
    throw new Error(`verify:derived-alice failed: ${(verify.stderr || verify.stdout || '').trim()}`);
  }

  const smoke = spawnSync('npm', ['run', 'smoke:derived-anomaly-alert'], {
    cwd: umaRepo,
    env: envVars,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  logCommandResult(logFile, 'npm', ['run', 'smoke:derived-anomaly-alert'], smoke);
  if (smoke.status !== 0) {
    throw new Error(`smoke:derived-anomaly-alert failed: ${(smoke.stderr || smoke.stdout || '').trim()}`);
  }
}

async function measureProtectedAlertAccess(config) {
  const initialStart = nowMs();
  const initialResponse = await fetch(config.alertTarget, { method: 'GET' });
  const initialLatency = nowMs() - initialStart;

  if (initialResponse.status === 200) {
    throw new Error(`Unauthenticated alert GET returned 200 for ${config.alertTarget}; the resource is public.`);
  }

  if (!(initialResponse.status === 401 || initialResponse.status === 403)) {
    const body = await initialResponse.text().catch(() => '');
    throw new Error(`Expected UMA challenge or protected-resource denial for ${config.alertTarget}, got ${initialResponse.status}. Body: ${body.slice(0, 200)}`);
  }

  const wwwAuthenticate = initialResponse.headers.get('WWW-Authenticate') || '';
  const challenge = parseUmaChallenge(wwwAuthenticate);

  const tokenStart = nowMs();
  const tokenResponse = await fetch(challenge.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket: challenge.ticket,
      claim_token: encodeURIComponent(config.claimToken),
      claim_token_format: config.claimTokenFormat,
    }),
  });
  const tokenRaw = await tokenResponse.text();
  const tokenLatency = nowMs() - tokenStart;

  let tokenJson = null;
  try {
    tokenJson = JSON.parse(tokenRaw);
  } catch {
    tokenJson = null;
  }

  if (tokenResponse.status !== 200) {
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${tokenRaw.slice(0, 500)}`);
  }

  const accessToken = tokenJson?.access_token;
  const tokenType = tokenJson?.token_type || 'Bearer';
  if (!accessToken) {
    throw new Error('Token exchange succeeded but no access_token was returned.');
  }

  const authorizedStart = nowMs();
  const authorizedResponse = await fetch(config.alertTarget, {
    method: 'GET',
    headers: { Authorization: `${tokenType} ${accessToken}` },
  });
  const authorizedBody = await authorizedResponse.text();
  const authorizedLatency = nowMs() - authorizedStart;

  if (authorizedResponse.status !== 200) {
    throw new Error(`Authorized alert GET failed (${authorizedResponse.status}): ${authorizedBody.slice(0, 500)}`);
  }

  return {
    alert_target: config.alertTarget,
    challenge_status: initialResponse.status,
    token_status: tokenResponse.status,
    authorized_status: authorizedResponse.status,
    alert_uma_initial_challenge_ms: initialLatency,
    alert_uma_token_exchange_ms: tokenLatency,
    alert_authorized_get_ms: authorizedLatency,
    alert_total_first_access_ms: authorizedLatency + tokenLatency + initialLatency,
    final_alert_get_succeeded: true,
    alert_response_preview: authorizedBody.slice(0, 500),
  };
}

function parseArgs(argv) {
  const result = {
    runs: Number(env('RUNS', '30')),
    warmup: Number(env('WARMUP', '5')),
    benchmarkId: env('BENCHMARK_ID', ''),
    noManagedStack: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--runs') result.runs = Number(next);
    if (arg === '--warmup') result.warmup = Number(next);
    if (arg === '--benchmark-id') result.benchmarkId = next;
    if (arg === '--no-managed-stack') result.noManagedStack = true;
  }

  if (!Number.isFinite(result.runs) || result.runs < 1) {
    throw new Error('--runs must be >= 1');
  }
  if (!Number.isFinite(result.warmup) || result.warmup < 0) {
    throw new Error('--warmup must be >= 0');
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.benchmarkId || new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = createOutputDir(runId);
  const rawPath = path.join(outputDir, `protected-alert-access-${runId}.runs.jsonl`);
  const summaryPath = path.join(outputDir, `protected-alert-access-${runId}.summary.json`);
  const preflightLog = path.join(outputDir, 'managed-preflight.log');

  const alertTarget = env('PANDA_ALERT_TARGET', 'http://localhost:3000/alice/derived/anomaly-alert/');
  const claimToken = env('PANDA_UMA_CLAIM_TOKEN', 'http://localhost:3000/bob/profile/card#me');
  const claimTokenFormat = env('PANDA_UMA_CLAIM_TOKEN_FORMAT', 'urn:solidlab:uma:claims:formats:webid');
  const managedStack = !args.noManagedStack;

  const config = {
    alertTarget,
    claimToken,
    claimTokenFormat,
    managedStack,
  };

  if (managedStack) {
    const umaRepo = resolveRepoPath({
      cliValue: null,
      envVarName: 'UMA_REPO',
      defaultPath: siblingDefaults.umaRepo,
    });
    ensureRepoExists(umaRepo, {
      label: 'user-managed-access',
      envVarName: 'UMA_REPO',
      cliFlagName: null,
    });
    runManagedPreflight(umaRepo, preflightLog);
  }

  const rows = [];
  const totalIterations = args.warmup + args.runs;
  let failure = null;

  for (let iteration = 0; iteration < totalIterations; iteration += 1) {
    const phase = iteration < args.warmup ? 'warmup' : 'measured';
    const row = {
      benchmark_name: 'protected-alert-access',
      run_id: runId,
      phase,
      iteration: iteration + 1,
      alert_target: alertTarget,
      requester_webid: claimToken,
      action: 'read',
      expected_outcome: 'authorized',
      challenge_status: null,
      token_status: null,
      authorized_status: null,
      alert_uma_initial_challenge_ms: null,
      alert_uma_token_exchange_ms: null,
      alert_authorized_get_ms: null,
      alert_total_first_access_ms: null,
      final_alert_get_succeeded: false,
      outcome: 'failed',
      status: 'failed',
      error: '',
    };

    try {
      const access = await measureProtectedAlertAccess(config);
      Object.assign(row, access);
      row.outcome = 'authorized';
      row.status = 'ok';
      row.error = '';
    } catch (error) {
      row.error = error?.message || String(error);
      if (!failure) {
        failure = error;
      }
    }

    rows.push(row);
  }

  const measuredRows = rows.filter((row) => row.phase === 'measured');
  const successfulMeasuredRows = measuredRows.filter((row) => row.status === 'ok' && row.final_alert_get_succeeded);
  const failedMeasuredRows = measuredRows.filter((row) => !(row.status === 'ok' && row.final_alert_get_succeeded));
  const anyFailedRows = rows.filter((row) => !(row.status === 'ok' && row.final_alert_get_succeeded));

  const summary = {
    benchmark_name: 'protected-alert-access',
    run_id: runId,
    request: {
      requester_webid: claimToken,
      alert_target: alertTarget,
      action: 'read',
      expected_outcome: 'authorized',
    },
    managed_stack: managedStack,
    preflight: managedStack
      ? {
          verified: true,
          commands: ['npm run verify:derived-alice', 'npm run smoke:derived-anomaly-alert'],
          log_file: preflightLog,
        }
      : {
          verified: false,
          commands: [],
          log_file: null,
        },
    run_count: args.runs,
    warmup_count: args.warmup,
    measured_run_count: measuredRows.length,
    authorized_runs: successfulMeasuredRows.length,
    failed_runs: failedMeasuredRows.length,
    outcome: anyFailedRows.length === 0 && successfulMeasuredRows.length === args.runs ? 'authorized' : 'failed',
    status: anyFailedRows.length === 0 && successfulMeasuredRows.length === args.runs ? 'ok' : 'failed',
    metrics: {
      alert_uma_initial_challenge_ms: summarize(successfulMeasuredRows.map((row) => row.alert_uma_initial_challenge_ms)),
      alert_uma_token_exchange_ms: summarize(successfulMeasuredRows.map((row) => row.alert_uma_token_exchange_ms)),
      alert_authorized_get_ms: summarize(successfulMeasuredRows.map((row) => row.alert_authorized_get_ms)),
      alert_total_first_access_ms: summarize(successfulMeasuredRows.map((row) => row.alert_total_first_access_ms)),
    },
    rows,
    output_dir: outputDir,
    raw_path: rawPath,
    summary_path: summaryPath,
  };

  fs.writeFileSync(rawPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(JSON.stringify({ output_dir: outputDir, summary_path: summaryPath }, null, 2));

  if (failure || summary.status !== 'ok') {
    if (failure) {
      console.error(`[protected-alert-access] FAILED: ${failure.message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[protected-alert-access] FAILED: ${error.message}`);
  process.exitCode = 1;
});