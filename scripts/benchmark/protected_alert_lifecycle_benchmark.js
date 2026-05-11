#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const {
  repoRoot,
  siblingDefaults,
  resolveRepoPath,
  ensureRepoExists,
} = require('./workspace_paths');

const ROOT = repoRoot;
const SCENARIO_ID = 'uma-replayer-panda-derived-anomaly-e2e';

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function summarize(values) {
  const filtered = values.filter((value) => isFiniteNumber(value));
  if (!filtered.length) {
    return { n: 0, mean: null, stddev: null, median: null, p95: null, min: null, max: null };
  }
  const sorted = filtered.slice().sort((left, right) => left - right);
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / sorted.length;
  const pick = (p) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  };
  return {
    n: sorted.length,
    mean: Number(avg.toFixed(3)),
    stddev: Number(Math.sqrt(variance).toFixed(3)),
    median: Number(pick(50).toFixed(3)),
    p95: Number(pick(95).toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

function parseArgs(argv) {
  const out = {
    runs: Number(env('RUNS', '30')),
    warmup: Number(env('WARMUP', '5')),
    benchmarkId: env('BENCHMARK_ID', ''),
    noManagedStack: false,
    pandaHttpUrl: env('PANDA_HTTP_URL', 'http://localhost:8080/'),
    pandaWsUrl: env('PANDA_WS_URL', 'ws://localhost:8080/'),
    continueOnFailure: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--runs') out.runs = Number(next);
    if (arg === '--warmup') out.warmup = Number(next);
    if (arg === '--benchmark-id') out.benchmarkId = next;
    if (arg === '--no-managed-stack') out.noManagedStack = true;
    if (arg === '--panda-http-url') out.pandaHttpUrl = next;
    if (arg === '--panda-ws-url') out.pandaWsUrl = next;
    if (arg === '--continue-on-failure') out.continueOnFailure = true;
  }

  if (!Number.isFinite(out.runs) || out.runs < 1) {
    throw new Error('--runs must be >= 1');
  }
  if (!Number.isFinite(out.warmup) || out.warmup < 0) {
    throw new Error('--warmup must be >= 0');
  }
  return out;
}

function commandForDisplay(command, args) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
}

function parseUmaChallenge(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader || !/^UMA\s+/i.test(wwwAuthenticateHeader)) {
    throw new Error(`Missing or invalid UMA challenge header: ${wwwAuthenticateHeader || 'none'}`);
  }
  const withoutScheme = wwwAuthenticateHeader.replace(/^UMA\s+/i, '');
  const params = Object.fromEntries(
    withoutScheme.split(/\s*,\s*/).map((param) => {
      const separator = param.indexOf('=');
      if (separator < 0) return [param.trim(), ''];
      const key = param.slice(0, separator).trim();
      const value = param.slice(separator + 1).trim().replace(/^"|"$/g, '');
      return [key, value];
    }),
  );
  if (!params.ticket || !params.as_uri) {
    throw new Error(`UMA challenge missing ticket/as_uri: ${wwwAuthenticateHeader}`);
  }
  return {
    tokenEndpoint: new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString(),
    ticket: params.ticket,
  };
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return response.status;
    } catch (_) {
      // keep polling
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function spawnLogged(command, args, options, logFile) {
  ensureDir(path.dirname(logFile));
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    detached: true,
    shell: false,
  });
  child.stdout.on('data', (chunk) => out.write(chunk));
  child.stderr.on('data', (chunk) => out.write(chunk));
  child.on('exit', (code, signal) => out.write(`[process_exit] code=${code} signal=${signal}\n`));
  child.displayCommand = commandForDisplay(command, args);
  return child;
}

function stopChild(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (_) {
    try {
      child.kill('SIGTERM');
    } catch (_) {
      // ignore
    }
  }
}

function findPidsOnPort(port) {
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).trim();
    return output ? output.split(/\s+/).map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [];
  } catch (_) {
    return [];
  }
}

function assertPortAvailable(port, name) {
  const pids = findPidsOnPort(port).filter((pid) => pid !== process.pid);
  if (!pids.length) return;
  throw new Error(
    `Managed stack cannot start because port ${port} (${name}) is already in use by PID(s): ${pids.join(', ')}. Stop existing services or use --no-managed-stack.`,
  );
}

async function measureProtectedRead(target, claimToken, claimTokenFormat) {
  const row = {
    challenge_status: null,
    token_status: null,
    authorized_status: null,
    uma_initial_challenge_ms: null,
    uma_token_exchange_ms: null,
    authorized_get_ms: null,
    total_first_access_ms: null,
    unauthenticated_was_public: false,
    challenge_present: false,
    authorized_body_preview: '',
  };

  const totalStart = nowMs();

  const challengeStart = nowMs();
  const challengeResponse = await fetch(target, { method: 'GET' });
  row.uma_initial_challenge_ms = nowMs() - challengeStart;
  row.challenge_status = challengeResponse.status;
  row.unauthenticated_was_public = challengeResponse.status === 200;
  if (challengeResponse.status === 200) {
    row.total_first_access_ms = nowMs() - totalStart;
    throw new Error(`Unauthenticated GET returned HTTP 200 for protected resource ${target}`);
  }
  if (challengeResponse.status !== 401) {
    const body = await challengeResponse.text().catch(() => '');
    row.total_first_access_ms = nowMs() - totalStart;
    throw new Error(`Expected HTTP 401 UMA challenge for ${target}, got ${challengeResponse.status}. Body: ${body.slice(0, 300)}`);
  }

  const wwwAuthenticate = challengeResponse.headers.get('WWW-Authenticate') || '';
  const challenge = parseUmaChallenge(wwwAuthenticate);
  row.challenge_present = true;

  const tokenStart = nowMs();
  const tokenResponse = await fetch(challenge.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket: challenge.ticket,
      claim_token: encodeURIComponent(claimToken),
      claim_token_format: claimTokenFormat,
    }),
  });
  const tokenRaw = await tokenResponse.text();
  row.uma_token_exchange_ms = nowMs() - tokenStart;
  row.token_status = tokenResponse.status;
  if (tokenResponse.status !== 200) {
    row.total_first_access_ms = nowMs() - totalStart;
    throw new Error(`Token exchange failed for ${target} (${tokenResponse.status}): ${tokenRaw.slice(0, 500)}`);
  }
  let tokenJson = null;
  try {
    tokenJson = JSON.parse(tokenRaw);
  } catch {
    tokenJson = null;
  }
  const accessToken = tokenJson?.access_token;
  const tokenType = tokenJson?.token_type || 'Bearer';
  if (!accessToken) {
    row.total_first_access_ms = nowMs() - totalStart;
    throw new Error(`Token exchange succeeded but missing access_token for ${target}`);
  }

  const authorizedStart = nowMs();
  const authorizedResponse = await fetch(target, {
    method: 'GET',
    headers: { Authorization: `${tokenType} ${accessToken}` },
  });
  const authorizedBody = await authorizedResponse.text().catch(() => '');
  row.authorized_get_ms = nowMs() - authorizedStart;
  row.authorized_status = authorizedResponse.status;
  row.authorized_body_preview = authorizedBody.slice(0, 500);
  row.total_first_access_ms = nowMs() - totalStart;
  if (authorizedResponse.status !== 200) {
    throw new Error(`Authorized GET failed for ${target} (${authorizedResponse.status}): ${authorizedBody.slice(0, 500)}`);
  }

  return row;
}

function extractLifecycleTimings(raw) {
  const metrics = raw?.metrics || {};
  return {
    stream_replay_ms: isFiniteNumber(raw?.replayer_process?.actual_process_runtime_ms)
      ? raw.replayer_process.actual_process_runtime_ms
      : null,
    observation_ingest_ms: isFiniteNumber(metrics.replayer_observation_write_to_panda_receive_ms)
      ? metrics.replayer_observation_write_to_panda_receive_ms
      : null,
    rsp_processing_ms: isFiniteNumber(metrics.query_registration_to_first_rsp_output_ms)
      ? metrics.query_registration_to_first_rsp_output_ms
      : null,
    rule_evaluation_ms: null,
    alert_generation_ms: isFiniteNumber(metrics.panda_receive_to_anomaly_detected_ms)
      ? metrics.panda_receive_to_anomaly_detected_ms
      : null,
    alert_write_ms: isFiniteNumber(metrics.panda_anomaly_pod_write_total_ms)
      ? metrics.panda_anomaly_pod_write_total_ms
      : null,
  };
}

function assertLifecycleRaw(raw, iterationBenchmarkId) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Missing raw lifecycle result for ${iterationBenchmarkId}`);
  }
  if (raw.status !== 'complete') {
    throw new Error(`Lifecycle scenario did not complete for ${iterationBenchmarkId}`);
  }
  if (raw.output_check?.passed !== true) {
    throw new Error(`Lifecycle scenario output_check failed for ${iterationBenchmarkId}`);
  }
  if (!raw.benchmark_run_id || typeof raw.benchmark_run_id !== 'string') {
    throw new Error(`Lifecycle raw missing benchmark_run_id for ${iterationBenchmarkId}`);
  }
  if (raw.actor_proof?.replayer_wrote_spo2_observations !== true) {
    throw new Error('Lifecycle scenario did not prove SpO2 replay writes');
  }
  if (raw.actor_proof?.current_run_rsp_output_observed !== true) {
    throw new Error('Lifecycle scenario did not observe current-run RSP output');
  }
  if (raw.actor_proof?.panda_wrote_anomaly_alerts !== true) {
    throw new Error('Lifecycle scenario did not prove PANDA alert creation');
  }
  if (raw.latest_anomaly_diagnostics?.rsp_proof_verified !== true) {
    throw new Error('Lifecycle scenario did not prove current-run RSP-derived alert freshness');
  }
  if (!String(raw.latest_anomaly_sample || '').includes(raw.benchmark_run_id)) {
    throw new Error('Lifecycle scenario latest-anomaly sample did not include current benchmark_run_id');
  }
  if (raw.alert_rsp_proof?.benchmark_run_id !== raw.benchmark_run_id) {
    throw new Error('Lifecycle scenario alert log benchmark_run_id did not match current run');
  }
}

function runOneDerivedLifecycle(iterationBenchmarkId, opts, envOverride, logPath) {
  ensureDir(path.dirname(logPath));
  const args = [
    'scripts/benchmark/run_all_scenarios.js',
    '--mode', 'smoke',
    '--runs', '1',
    '--warmup', '0',
    '--only-scenario', SCENARIO_ID,
    '--benchmark-id', iterationBenchmarkId,
    '--panda-http-url', opts.pandaHttpUrl,
    '--panda-ws-url', opts.pandaWsUrl,
  ];
  const result = spawnSync('node', args, {
    cwd: ROOT,
    env: envOverride,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  const rendered = [
    `$ node ${args.join(' ')}`,
    result.stdout || '',
    result.stderr || '',
    `[process_exit] code=${result.status ?? 0}`,
    '',
  ].join('\n');
  fs.appendFileSync(logPath, rendered);
  if (result.status !== 0) {
    throw new Error(
      `Derived lifecycle scenario runner failed for ${iterationBenchmarkId}. See ${logPath}`,
    );
  }
  const rawPath = path.join(
    ROOT,
    'benchmarks',
    'results',
    'runs',
    iterationBenchmarkId,
    'raw',
    `${SCENARIO_ID}-run-1.json`,
  );
  if (!fs.existsSync(rawPath)) {
    throw new Error(`Derived lifecycle raw output not found: ${rawPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  assertLifecycleRaw(raw, iterationBenchmarkId);
  return { raw, rawPath };
}

async function startManagedServices(config, outputDir) {
  const managedDir = path.join(outputDir, 'managed-stack');
  ensureDir(managedDir);

  assertPortAvailable(3000, 'CSS');
  assertPortAvailable(4000, 'UMA AS');
  assertPortAvailable(8080, 'PANDA');

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

  const umaLogFile = path.join(managedDir, 'uma-odrl.log');
  const pandaLogFile = path.join(managedDir, 'panda-managed.log');

  const umaChild = spawnLogged('corepack', ['yarn', 'start:odrl'], {
    cwd: umaRepo,
    env: process.env,
  }, umaLogFile);

  await waitForHttp('http://localhost:4000/uma/.well-known/uma2-configuration', 120000);
  await waitForHttp('http://localhost:3000/', 120000);

  const pandaEnv = {
    ...process.env,
    BENCHMARK_TIMING: '1',
    PANDA_MONITOR_LOG_FILE: pandaLogFile,
    PANDA_LOG_FILE: pandaLogFile,
  };
  const pandaChild = spawnLogged('npm', ['run', 'start-monitoring'], {
    cwd: ROOT,
    env: pandaEnv,
  }, pandaLogFile);

  await waitForHttp(config.pandaHttpUrl, 120000);

  return {
    umaChild,
    pandaChild,
    umaLogFile,
    pandaLogFile,
    managedDir,
    managedStack: true,
    umaRepo,
  };
}

async function assertUnmanagedReachable(config) {
  await waitForHttp('http://localhost:4000/uma/.well-known/uma2-configuration', 10000);
  await waitForHttp('http://localhost:3000/', 10000);
  await waitForHttp(config.pandaHttpUrl, 10000);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const managedStack = !args.noManagedStack;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = args.benchmarkId || timestamp;
  const outputDir = path.join(ROOT, 'benchmark-results', `protected-alert-lifecycle-${timestamp}`);
  ensureDir(outputDir);
  const runsPath = path.join(outputDir, `protected-alert-lifecycle-${runId}.runs.jsonl`);
  const summaryPath = path.join(outputDir, `protected-alert-lifecycle-${runId}.summary.json`);
  const iterationLogsDir = path.join(outputDir, 'iteration-logs');
  ensureDir(iterationLogsDir);

  const spo2Target = env('PANDA_SPO2_TARGET', 'http://localhost:3000/alice/spo2/');
  const alertTarget = env('PANDA_ALERT_TARGET', 'http://localhost:3000/alice/derived/anomaly-alert/');
  const requesterWebId = env('PANDA_UMA_CLAIM_TOKEN', 'http://localhost:3000/bob/profile/card#me');
  const claimTokenFormat = env('PANDA_UMA_CLAIM_TOKEN_FORMAT', 'urn:solidlab:uma:claims:formats:webid');

  let managed = null;
  let firstFailure = null;
  const rows = [];
  try {
    if (managedStack) {
      managed = await startManagedServices(args, outputDir);
    } else {
      await assertUnmanagedReachable(args);
    }

    const commonEnv = {
      ...process.env,
      BENCHMARK_TIMING: '1',
      PANDA_UMA_ODRL_LOG_FILE: managed?.umaLogFile || process.env.PANDA_UMA_ODRL_LOG_FILE || '',
      UMA_ODRL_LOG_FILE: managed?.umaLogFile || process.env.UMA_ODRL_LOG_FILE || '',
      PANDA_MONITOR_LOG_FILE: managed?.pandaLogFile || process.env.PANDA_MONITOR_LOG_FILE || '',
      PANDA_LOG_FILE: managed?.pandaLogFile || process.env.PANDA_LOG_FILE || '',
    };

    const totalIterations = args.warmup + args.runs;
    for (let index = 0; index < totalIterations; index += 1) {
      const phase = index < args.warmup ? 'warmup' : 'measured';
      const phaseIteration = phase === 'warmup' ? index + 1 : (index - args.warmup + 1);
      const iterationStart = nowMs();
      const iterationBenchmarkId = `protected-alert-lifecycle-${runId}-${phase}-${phaseIteration}`;
      const iterationLogPath = path.join(iterationLogsDir, `${iterationBenchmarkId}.log`);

      const row = {
        benchmark_name: 'protected-alert-lifecycle',
        run_id: runId,
        phase,
        iteration: phaseIteration,
        benchmark_run_id: null,
        spo2_target: spo2Target,
        alert_target: alertTarget,
        input_challenge_status: null,
        input_token_status: null,
        input_authorized_status: null,
        alert_created: false,
        alert_resource_exists: false,
        alert_challenge_status: null,
        alert_token_status: null,
        alert_authorized_status: null,
        unauthenticated_alert_get_was_public: false,
        final_alert_get_succeeded: false,
        lifecycle_proof_current_run_generated: false,
        lifecycle_raw_path: null,
        lifecycle_runner_benchmark_id: iterationBenchmarkId,
        input_uma_initial_challenge_ms: null,
        input_uma_token_exchange_ms: null,
        input_authorized_get_ms: null,
        input_total_first_access_ms: null,
        stream_replay_ms: null,
        observation_ingest_ms: null,
        rsp_processing_ms: null,
        rule_evaluation_ms: null,
        alert_generation_ms: null,
        alert_write_ms: null,
        alert_uma_initial_challenge_ms: null,
        alert_uma_token_exchange_ms: null,
        alert_authorized_get_ms: null,
        alert_total_first_access_ms: null,
        total_lifecycle_ms: null,
        outcome: 'failed',
        status: 'failed',
        error: '',
      };

      try {
        const inputAccess = await measureProtectedRead(spo2Target, requesterWebId, claimTokenFormat);
        row.input_challenge_status = inputAccess.challenge_status;
        row.input_token_status = inputAccess.token_status;
        row.input_authorized_status = inputAccess.authorized_status;
        row.input_uma_initial_challenge_ms = inputAccess.uma_initial_challenge_ms;
        row.input_uma_token_exchange_ms = inputAccess.uma_token_exchange_ms;
        row.input_authorized_get_ms = inputAccess.authorized_get_ms;
        row.input_total_first_access_ms = inputAccess.total_first_access_ms;

        const { raw, rawPath } = runOneDerivedLifecycle(iterationBenchmarkId, args, commonEnv, iterationLogPath);
        row.lifecycle_raw_path = rawPath;
        row.benchmark_run_id = raw.benchmark_run_id;
        row.alert_created = raw.actor_proof?.panda_wrote_anomaly_alerts === true;
        row.lifecycle_proof_current_run_generated = row.alert_created
          && raw.alert_rsp_proof?.benchmark_run_id === raw.benchmark_run_id
          && String(raw.latest_anomaly_sample || '').includes(raw.benchmark_run_id);

        const lifecycleTimings = extractLifecycleTimings(raw);
        Object.assign(row, lifecycleTimings);

        const alertAccess = await measureProtectedRead(alertTarget, requesterWebId, claimTokenFormat);
        row.alert_challenge_status = alertAccess.challenge_status;
        row.alert_token_status = alertAccess.token_status;
        row.alert_authorized_status = alertAccess.authorized_status;
        row.unauthenticated_alert_get_was_public = alertAccess.unauthenticated_was_public;
        row.alert_resource_exists = alertAccess.challenge_status !== 404;
        row.alert_uma_initial_challenge_ms = alertAccess.uma_initial_challenge_ms;
        row.alert_uma_token_exchange_ms = alertAccess.uma_token_exchange_ms;
        row.alert_authorized_get_ms = alertAccess.authorized_get_ms;
        row.alert_total_first_access_ms = alertAccess.total_first_access_ms;
        row.final_alert_get_succeeded = alertAccess.authorized_status === 200;

        if (!row.alert_created) {
          throw new Error('PANDA did not generate an alert for this iteration');
        }
        if (!row.lifecycle_proof_current_run_generated) {
          throw new Error('Stale alert risk: current-run lifecycle proof is missing');
        }
        if (row.unauthenticated_alert_get_was_public) {
          throw new Error('Unauthenticated alert GET returned HTTP 200');
        }
        if (row.alert_challenge_status !== 401) {
          throw new Error(`Alert challenge status must be 401, got ${row.alert_challenge_status}`);
        }
        if (row.alert_token_status !== 200) {
          throw new Error(`Alert token exchange must return 200, got ${row.alert_token_status}`);
        }
        if (row.alert_authorized_status !== 200) {
          throw new Error(`Alert authorized GET must return 200, got ${row.alert_authorized_status}`);
        }
        if (row.input_challenge_status !== 401) {
          throw new Error(`Input challenge status must be 401, got ${row.input_challenge_status}`);
        }
        if (row.input_token_status !== 200) {
          throw new Error(`Input token exchange must return 200, got ${row.input_token_status}`);
        }
        if (row.input_authorized_status !== 200) {
          throw new Error(`Input authorized GET must return 200, got ${row.input_authorized_status}`);
        }

        row.status = 'ok';
        row.outcome = 'authorized';
        row.error = '';
      } catch (error) {
        row.status = 'failed';
        row.outcome = 'failed';
        row.error = error?.message || String(error);
        if (!firstFailure) firstFailure = error;
      }

      row.total_lifecycle_ms = nowMs() - iterationStart;
      rows.push(row);

      fs.appendFileSync(runsPath, `${JSON.stringify(row)}\n`);

      if (row.status !== 'ok' && !args.continueOnFailure) {
        break;
      }
    }
  } finally {
    stopChild(managed?.pandaChild);
    stopChild(managed?.umaChild);
  }

  const measuredRows = rows.filter((row) => row.phase === 'measured');
  const successfulMeasuredRows = measuredRows.filter((row) => row.status === 'ok' && row.outcome === 'authorized');
  const failedMeasuredRows = measuredRows.filter((row) => !(row.status === 'ok' && row.outcome === 'authorized'));
  const alertGeneratedMeasured = measuredRows.filter((row) => row.alert_created === true);

  const summary = {
    benchmark_name: 'protected-alert-lifecycle',
    run_id: runId,
    output_dir: outputDir,
    runs_path: runsPath,
    summary_path: summaryPath,
    request: {
      requester_webid: requesterWebId,
      spo2_target: spo2Target,
      alert_target: alertTarget,
      action: 'read',
      expected_outcome: 'authorized',
    },
    managed_stack: managedStack,
    warmup_count: args.warmup,
    measured_run_count: measuredRows.length,
    run_count: args.runs,
    authorized_runs: successfulMeasuredRows.length,
    failed_runs: failedMeasuredRows.length,
    alert_generated_runs: alertGeneratedMeasured.length,
    status: measuredRows.length === args.runs && failedMeasuredRows.length === 0 ? 'ok' : 'failed',
    outcome: measuredRows.length === args.runs && failedMeasuredRows.length === 0 ? 'authorized' : 'failed',
    metrics: {
      input_uma_initial_challenge_ms: summarize(successfulMeasuredRows.map((row) => row.input_uma_initial_challenge_ms)),
      input_uma_token_exchange_ms: summarize(successfulMeasuredRows.map((row) => row.input_uma_token_exchange_ms)),
      input_authorized_get_ms: summarize(successfulMeasuredRows.map((row) => row.input_authorized_get_ms)),
      input_total_first_access_ms: summarize(successfulMeasuredRows.map((row) => row.input_total_first_access_ms)),

      stream_replay_ms: summarize(successfulMeasuredRows.map((row) => row.stream_replay_ms)),
      observation_ingest_ms: summarize(successfulMeasuredRows.map((row) => row.observation_ingest_ms)),
      rsp_processing_ms: summarize(successfulMeasuredRows.map((row) => row.rsp_processing_ms)),
      rule_evaluation_ms: summarize(successfulMeasuredRows.map((row) => row.rule_evaluation_ms)),
      alert_generation_ms: summarize(successfulMeasuredRows.map((row) => row.alert_generation_ms)),
      alert_write_ms: summarize(successfulMeasuredRows.map((row) => row.alert_write_ms)),

      alert_uma_initial_challenge_ms: summarize(successfulMeasuredRows.map((row) => row.alert_uma_initial_challenge_ms)),
      alert_uma_token_exchange_ms: summarize(successfulMeasuredRows.map((row) => row.alert_uma_token_exchange_ms)),
      alert_authorized_get_ms: summarize(successfulMeasuredRows.map((row) => row.alert_authorized_get_ms)),
      alert_total_first_access_ms: summarize(successfulMeasuredRows.map((row) => row.alert_total_first_access_ms)),

      total_lifecycle_ms: summarize(successfulMeasuredRows.map((row) => row.total_lifecycle_ms)),
    },
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ output_dir: outputDir, summary_path: summaryPath, runs_path: runsPath }, null, 2));

  if (summary.status !== 'ok' || firstFailure) {
    if (firstFailure) {
      console.error(`[protected-alert-lifecycle] FAILED: ${firstFailure.message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[protected-alert-lifecycle] FAILED: ${error.message}`);
  process.exitCode = 1;
});
