#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const {
  resolveRepoPath,
  siblingDefaults,
  ensureRepoExists,
  repoRoot,
} = require('./workspace_paths');
const {
  DEFAULT_WEBID_CLAIM_TOKEN_FORMAT,
  parseUmaChallenge,
  resolveIdentities,
  runBenchmark,
  runPreflight,
} = require('./run_concurrent_cold_uma_authorization');

const ROOT = repoRoot;
const RESULTS_ROOT = path.join(ROOT, 'benchmarks', 'results', 'runs');
const DEFAULT_TARGET_URL = 'http://localhost:3000/alice/spo2/';
const DEFAULT_TOKEN_ENDPOINT = 'http://localhost:4000/uma/token';
const DEFAULT_CONCURRENCY_LEVELS = '1,2,5,10,20';
const DEFAULT_BURSTS = 30;
const DEFAULT_BURST_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_OWNER_WEBID = 'http://localhost:3000/alice/profile/card#me';
const DEFAULT_NURSE_WEBID = 'http://localhost:3000/bob/profile/card#me';
const PROC_PORTS = [3000, 4000];

function parseArgs(argv) {
  const out = {
    benchmarkId: `cold-concurrent-uma-odrl-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    concurrencyLevelsCsv: DEFAULT_CONCURRENCY_LEVELS,
    bursts: DEFAULT_BURSTS,
    burstDelayMs: DEFAULT_BURST_DELAY_MS,
    targetUrl: DEFAULT_TARGET_URL,
    umaTokenEndpoint: DEFAULT_TOKEN_ENDPOINT,
    authorizedWebids: null,
    claimToken: null,
    claimTokens: null,
    claimTokenFile: null,
    claimTokenFormat: DEFAULT_WEBID_CLAIM_TOKEN_FORMAT,
    force: false,
    keepServicesRunning: false,
    skipPreflightFullFlow: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    switch (key) {
      case '--benchmark-id':
        out.benchmarkId = readValue(argv, i, key);
        i += 1;
        break;
      case '--concurrency-levels':
        out.concurrencyLevelsCsv = readValue(argv, i, key);
        i += 1;
        break;
      case '--bursts':
        out.bursts = Number(readValue(argv, i, key));
        i += 1;
        break;
      case '--burst-delay-ms':
        out.burstDelayMs = Number(readValue(argv, i, key));
        i += 1;
        break;
      case '--target-url':
        out.targetUrl = readValue(argv, i, key);
        i += 1;
        break;
      case '--uma-token-endpoint':
        out.umaTokenEndpoint = readValue(argv, i, key);
        i += 1;
        break;
      case '--authorized-webids':
        out.authorizedWebids = splitCsv(readValue(argv, i, key));
        i += 1;
        break;
      case '--claim-token':
        out.claimToken = readValue(argv, i, key);
        i += 1;
        break;
      case '--claim-tokens':
        out.claimTokens = splitCsv(readValue(argv, i, key));
        i += 1;
        break;
      case '--claim-token-file':
        out.claimTokenFile = readValue(argv, i, key);
        i += 1;
        break;
      case '--claim-token-format':
        out.claimTokenFormat = readValue(argv, i, key);
        i += 1;
        break;
      case '--timeout-ms':
        out.timeoutMs = Number(readValue(argv, i, key));
        i += 1;
        break;
      case '--force':
        out.force = true;
        break;
      case '--keep-services-running':
        out.keepServicesRunning = true;
        break;
      case '--skip-preflight-full-flow':
        out.skipPreflightFullFlow = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }

  out.concurrencyLevels = splitCsv(out.concurrencyLevelsCsv).map((value) => Number(value));
  if (!out.targetUrl) throw new Error('--target-url is required');
  if (!out.umaTokenEndpoint) throw new Error('--uma-token-endpoint is required');
  if (!Array.isArray(out.concurrencyLevels) || out.concurrencyLevels.length === 0 || out.concurrencyLevels.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`Invalid --concurrency-levels: ${out.concurrencyLevelsCsv}`);
  }
  if (!Number.isInteger(out.bursts) || out.bursts <= 0) {
    throw new Error(`Invalid --bursts: ${out.bursts}`);
  }
  if (!Number.isFinite(out.burstDelayMs) || out.burstDelayMs < 0) {
    throw new Error(`Invalid --burst-delay-ms: ${out.burstDelayMs}`);
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${out.timeoutMs}`);
  }
  return out;
}

function readValue(argv, i, flag) {
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage:
  node scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js [options]

Options:
  --benchmark-id <id>
  --concurrency-levels <csv>    Default: ${DEFAULT_CONCURRENCY_LEVELS}
  --bursts <n>                  Default: ${DEFAULT_BURSTS}
  --burst-delay-ms <n>          Default: ${DEFAULT_BURST_DELAY_MS}
  --target-url <url>            Default: ${DEFAULT_TARGET_URL}
  --uma-token-endpoint <url>    Default: ${DEFAULT_TOKEN_ENDPOINT}
  --authorized-webids <csv>
  --claim-token <token>
  --claim-tokens <csv>
  --claim-token-file <path>
  --claim-token-format <format> Default: ${DEFAULT_WEBID_CLAIM_TOKEN_FORMAT}
  --timeout-ms <n>              Default: ${DEFAULT_TIMEOUT_MS}
  --force
  --keep-services-running
  --skip-preflight-full-flow

Smoke:
BENCH_ID="cold-concurrent-uma-smoke-$(date +%Y%m%d-%H%M%S)"
node scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js \\
  --benchmark-id "$BENCH_ID" \\
  --concurrency-levels 1 \\
  --bursts 1 \\
  --force \\
  --keep-services-running

Final:
BENCH_ID="cold-concurrent-uma-final-$(date +%Y%m%d-%H%M%S)"
node scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js \\
  --benchmark-id "$BENCH_ID" \\
  --concurrency-levels 1,2,5,10,20 \\
  --bursts 30 \\
  --force`);
}

function splitCsv(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenizeCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandForDisplay(command, args) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
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

function killPortsIfForced(force, ports) {
  if (!force) return;
  for (const port of ports) {
    let pids = [];
    try {
      const output = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).trim();
      pids = output ? output.split(/\s+/) : [];
    } catch (_) {
      pids = [];
    }
    for (const pid of pids) {
      const numericPid = Number(pid);
      if (!Number.isFinite(numericPid) || numericPid <= 1 || numericPid === process.pid) continue;
      try {
        process.kill(numericPid, 'SIGTERM');
      } catch (_) {
        // process may already be gone
      }
    }
  }
}

function resolveScenarioDefaultWebids() {
  const scenarioPath = path.join(ROOT, 'benchmarks', 'scenarios', '10-uma-replayer-panda-derived-anomaly-e2e.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
    return {
      ownerWebid: parsed?.protected_result?.owner_webid || DEFAULT_OWNER_WEBID,
      nurseWebid: parsed?.protected_result?.nurse_webid || DEFAULT_NURSE_WEBID,
      source: scenarioPath,
    };
  } catch (_) {
    return {
      ownerWebid: DEFAULT_OWNER_WEBID,
      nurseWebid: DEFAULT_NURSE_WEBID,
      source: 'fallback-defaults',
    };
  }
}

function parseAuthenticateHeader(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) throw new Error('Missing WWW-Authenticate header');
  const params = Object.fromEntries(wwwAuthenticateHeader.replace(/^UMA\s+/i, '').split(/\s*,\s*/).map((param) => {
    const separatorIndex = param.indexOf('=');
    if (separatorIndex < 0) return [param.trim(), ''];
    return [param.slice(0, separatorIndex).trim(), param.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '')];
  }));
  if (!params.as_uri || !params.ticket) throw new Error(`Invalid UMA challenge: ${wwwAuthenticateHeader}`);
  return {
    tokenEndpoint: new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString(),
    ticket: params.ticket,
  };
}

function assertRawWebIdClaimToken(claimToken, claimTokenFormat) {
  if (claimTokenFormat !== DEFAULT_WEBID_CLAIM_TOKEN_FORMAT) {
    return;
  }
  const token = String(claimToken || '');
  if (!token.includes('://') || /%3A%2F%2F/i.test(token)) {
    throw new Error('Claim token appears URL-encoded; pass the raw WebID instead.');
  }
}

async function exchangeToken(tokenEndpoint, ticket, claimToken = DEFAULT_OWNER_WEBID, claimTokenFormat = DEFAULT_WEBID_CLAIM_TOKEN_FORMAT) {
  assertRawWebIdClaimToken(claimToken, claimTokenFormat);
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: encodeURIComponent(claimToken),
      claim_token_format: claimTokenFormat,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`UMA token exchange failed status=${response.status} body=${body}`);
  return JSON.parse(body);
}

async function fetchWithUma(url, init, authState) {
  const headers = new Headers(init.headers || {});
  if (authState.token) {
    headers.set('Authorization', `${authState.token.token_type || 'Bearer'} ${authState.token.access_token}`);
  }
  let response = await fetch(url, { ...init, headers });
  if (response.ok || (response.status !== 401 && response.status !== 403)) {
    return response;
  }
  const challenge = parseAuthenticateHeader(response.headers.get('WWW-Authenticate'));
  authState.token = await exchangeToken(challenge.tokenEndpoint, challenge.ticket, authState.claimToken, authState.claimTokenFormat);
  headers.set('Authorization', `${authState.token.token_type || 'Bearer'} ${authState.token.access_token}`);
  return fetch(url, { ...init, headers });
}

function containerPathFromUrl(url) {
  return new URL(url).pathname.replace(/^\/+|\/+$/g, '');
}

function makeSpo2Policy({ targetUrl, ownerWebid, readerWebids }) {
  const metaTargets = [
    'http://localhost:3000/alice/.meta',
    `${targetUrl}.meta`,
  ];
  const metaPermissions = metaTargets.map((target, index) => `
ex:writeMeta${index} a odrl:Permission ;
  odrl:target <${target}> ;
  odrl:assigner <${ownerWebid}> ;
  odrl:assignee <${ownerWebid}> ;
  odrl:action odrl:create, odrl:append, odrl:write, odrl:read .
`).join('\n');
  const readPermissions = readerWebids.map((webid, index) => `
ex:readSpo2${index} a odrl:Permission ;
  odrl:target <${targetUrl}> ;
  odrl:assigner <${ownerWebid}> ;
  odrl:assignee <${webid}> ;
  odrl:action odrl:read .
`).join('\n');
  return `
@prefix odrl: <http://www.w3.org/ns/odrl/2/> .
@prefix ex: <http://example.org/cold-concurrent-uma#> .

ex:policy a odrl:Agreement ;
  odrl:uid ex:policy ;
  odrl:permission ex:ownerAccess${readerWebids.map((_, index) => `, ex:readSpo2${index}`).join('')}${metaTargets.map((_, index) => `, ex:writeMeta${index}`).join('')} .

ex:ownerAccess a odrl:Permission ;
  odrl:target <${targetUrl}> ;
  odrl:assigner <${ownerWebid}> ;
  odrl:assignee <${ownerWebid}> ;
  odrl:action odrl:create, odrl:append, odrl:write, odrl:read .
${readPermissions}
${metaPermissions}
`.trim();
}

async function startUma(runRoot) {
  const logDir = path.join(runRoot, 'raw', 'uma-live-logs');
  ensureDir(logDir);
  const logFile = path.join(logDir, `uma-odrl-${path.basename(runRoot)}.log`);
  const defaults = resolveRepoDefaults();
  const startedAt = performance.now();
  const child = spawnLogged('corepack', ['yarn', 'start:odrl'], {
    cwd: defaults.umaDir,
    env: process.env,
  }, logFile);
  await waitForHttp('http://localhost:4000/uma/.well-known/uma2-configuration', 120000);
  await waitForHttp('http://localhost:3000/', 120000);
  return {
    child,
    logFile,
    cssStatePath: path.join(runRoot, 'raw', 'css-meta-files'),
    umaDir: defaults.umaDir,
    startupMs: performance.now() - startedAt,
  };
}

let repoDefaultsCache = null;
function resolveRepoDefaults() {
  if (repoDefaultsCache) return repoDefaultsCache;
  const umaDir = resolveRepoPath({
    cliValue: null,
    envVarName: 'UMA_REPO',
    defaultPath: siblingDefaults.umaRepo,
  });
  ensureRepoExists(umaDir, {
    label: 'user-managed-access',
    envVarName: 'UMA_REPO',
    cliFlagName: null,
  });
  repoDefaultsCache = { umaDir };
  return repoDefaultsCache;
}

async function bootstrapProtectedSpo2({
  targetUrl,
  ownerWebid,
  readerWebids,
  cssStatePath,
  skipPreflightFullFlow,
  identities,
  umaTokenEndpoint,
  timeoutMs,
}) {
  const authState = {
    token: null,
    claimToken: ownerWebid,
    claimTokenFormat: DEFAULT_WEBID_CLAIM_TOKEN_FORMAT,
  };
  const httpStatuses = [];
  const targetPath = containerPathFromUrl(targetUrl);
  ensureDir(path.join(cssStatePath, 'alice'));
  ensureDir(path.join(cssStatePath, targetPath));

  const policy = makeSpo2Policy({
    targetUrl,
    ownerWebid,
    readerWebids,
  });
  const policyResponse = await fetch('http://localhost:4000/uma/policies', {
    method: 'POST',
    headers: {
      Authorization: `WebID ${encodeURIComponent(ownerWebid)}`,
      'Content-Type': 'text/turtle',
    },
    body: policy,
  });
  httpStatuses.push({ phase: 'policy_post', status: policyResponse.status, url: 'http://localhost:4000/uma/policies' });
  if (!(policyResponse.status === 201 || policyResponse.status === 409)) {
    const body = await policyResponse.text().catch(() => '');
    throw new Error(`ODRL policy write failed status=${policyResponse.status} body=${body}`);
  }

  const containerResponse = await fetchWithUma(targetUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n',
  }, authState);
  httpStatuses.push({ phase: 'container_put', status: containerResponse.status, url: targetUrl });
  if (!(containerResponse.status >= 200 && containerResponse.status < 300) && containerResponse.status !== 409) {
    const body = await containerResponse.text().catch(() => '');
    throw new Error(`Container creation failed status=${containerResponse.status} url=${targetUrl} body=${body}`);
  }

  const metaFiles = new Map([
    ['alice/.meta', '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n'],
    [`${targetPath}/.meta`, '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n'],
  ]);
  for (const [relativePath, content] of metaFiles) {
    const absolutePath = path.join(cssStatePath, relativePath);
    ensureDir(path.dirname(absolutePath));
    fs.writeFileSync(absolutePath, content);
    const url = `http://localhost:3000/${relativePath}`;
    const response = await fetchWithUma(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: content,
    }, authState);
    httpStatuses.push({ phase: 'meta_put', status: response.status, url });
  }

  const preflightChallenge = await fetch(targetUrl, {
    method: 'GET',
    headers: { Accept: '*/*' },
  });
  const challengeHeader = preflightChallenge.headers.get('WWW-Authenticate') || '';
  if (preflightChallenge.status === 200) {
    throw new Error(`Target returned 200 on unauthenticated GET, so the benchmark is invalid because ${targetUrl} is public.`);
  }
  if (preflightChallenge.status === 404) {
    throw new Error(`Target is missing after bootstrap: ${targetUrl}`);
  }
  if (preflightChallenge.status !== 401) {
    throw new Error(`Expected target to return UMA 401 after bootstrap, got ${preflightChallenge.status}`);
  }
  if (!/^UMA\b/i.test(challengeHeader)) {
    throw new Error(`Target returned 401 but missing UMA challenge header: ${targetUrl}`);
  }
  const challenge = parseUmaChallenge(challengeHeader);
  if (!challenge.ticket) {
    throw new Error(`Target returned UMA challenge without a ticket: ${targetUrl}`);
  }

  await runPreflight({
    targetUrl,
    tokenEndpoint: umaTokenEndpoint,
    timeoutMs,
    identities,
    skipPreflightFullFlow,
  });

  return {
    httpStatuses,
    challengeHeader,
    protectedCheckPassed: true,
  };
}

function buildManifest(opts, runRoot, identities, webids) {
  return {
    benchmark_id: opts.benchmarkId,
    created_at: isoNow(),
    runner_command: commandForDisplay('node', [path.relative(ROOT, __filename), ...process.argv.slice(2)]),
    target_url: opts.targetUrl,
    uma_token_endpoint: opts.umaTokenEndpoint,
    concurrency_levels: opts.concurrencyLevels,
    bursts: opts.bursts,
    burst_delay_ms: opts.burstDelayMs,
    timeout_ms: opts.timeoutMs,
    force: opts.force,
    keep_services_running: opts.keepServicesRunning,
    skip_preflight_full_flow: opts.skipPreflightFullFlow,
    authorized_webids: webids,
    identities_count: identities.length,
    results_dir: runRoot,
  };
}

function validateOutputFiles(paths) {
  const missing = paths.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Expected output files are missing:\n${missing.join('\n')}`);
  }
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const defaults = resolveScenarioDefaultWebids();
  const requestedAuthorizedWebids = Array.isArray(opts.authorizedWebids) && opts.authorizedWebids.length > 0
    ? opts.authorizedWebids
    : [defaults.nurseWebid];
  const measurementOpts = {
    benchmarkId: opts.benchmarkId,
    targetUrl: opts.targetUrl,
    umaTokenEndpoint: opts.umaTokenEndpoint,
    claimToken: opts.claimToken,
    claimTokens: opts.claimTokens,
    claimTokenFile: opts.claimTokenFile,
    claimTokenFormat: opts.claimTokenFormat,
    authorizedWebids: requestedAuthorizedWebids,
    concurrencyLevels: opts.concurrencyLevels,
    bursts: opts.bursts,
    burstDelayMs: opts.burstDelayMs,
    timeoutMs: opts.timeoutMs,
    outputDir: path.join(RESULTS_ROOT, opts.benchmarkId, 'raw'),
    skipPreflightFullFlow: true,
  };
  const identities = resolveIdentities(measurementOpts);
  const policyAuthorizedWebids = uniqueValues([
    ...requestedAuthorizedWebids,
    ...identities.map((identity) => identity.webid).filter(Boolean),
  ]);
  const runRoot = path.join(RESULTS_ROOT, opts.benchmarkId);
  ensureDir(path.join(runRoot, 'raw'));
  ensureDir(path.join(runRoot, 'aggregated'));
  ensureDir(path.join(runRoot, 'failures'));

  const manifestPath = path.join(runRoot, 'manifest.json');
  const ledgerPath = path.join(runRoot, 'ledger.json');
  writeJson(manifestPath, buildManifest(opts, runRoot, identities, policyAuthorizedWebids));
  writeJson(ledgerPath, []);

  console.log(`benchmark_id=${opts.benchmarkId}`);
  console.log(`results_dir=${runRoot}`);
  console.log('uma_css_startup=started');

  let uma;
  let benchmarkResult;
  let startupCompleted = false;
  const ledger = [];
  try {
    killPortsIfForced(opts.force, PROC_PORTS);
    if (opts.force) await sleep(2000);
    uma = await startUma(runRoot);
    startupCompleted = true;
    console.log(`uma_css_startup=ready startup_ms=${Math.round(uma.startupMs)}`);

    const bootstrap = await bootstrapProtectedSpo2({
      targetUrl: opts.targetUrl,
      ownerWebid: defaults.ownerWebid,
      readerWebids: policyAuthorizedWebids,
      cssStatePath: uma.cssStatePath,
      skipPreflightFullFlow: opts.skipPreflightFullFlow,
      identities,
      umaTokenEndpoint: opts.umaTokenEndpoint,
      timeoutMs: opts.timeoutMs,
    });
    ledger.push({
      step: 'bootstrap',
      status: 'complete',
      completed_at: isoNow(),
      http_statuses: bootstrap.httpStatuses,
    });
    writeJson(ledgerPath, ledger);
    console.log('target_protected_check=passed');

    for (const concurrency of opts.concurrencyLevels) {
      console.log(`benchmark_progress concurrency=${concurrency} bursts=${opts.bursts}`);
    }

    benchmarkResult = await runBenchmark(measurementOpts);
    ledger.push({
      step: 'measurement',
      status: 'complete',
      completed_at: isoNow(),
      total_clients: benchmarkResult.totalClients,
      total_succeeded: benchmarkResult.totalSucceeded,
      total_failed: benchmarkResult.totalFailed,
    });
    writeJson(ledgerPath, ledger);

    if (!benchmarkResult || benchmarkResult.totalSucceeded <= 0) {
      throw new Error('All benchmark clients failed.');
    }
    validateOutputFiles([
      path.join(runRoot, 'raw', 'concurrent-cold-uma-client-results.jsonl'),
      path.join(runRoot, 'raw', 'concurrent-cold-uma-burst-results.jsonl'),
      path.join(runRoot, 'aggregated', 'concurrent-cold-uma-summary.json'),
      path.join(runRoot, 'aggregated', 'concurrent-cold-uma-summary.md'),
      manifestPath,
    ]);
    console.log('benchmark_complete=ok');
    console.log(`results_dir=${runRoot}`);
  } catch (error) {
    ledger.push({
      step: startupCompleted && !benchmarkResult ? 'bootstrap_or_measurement' : 'startup',
      status: 'failed',
      completed_at: isoNow(),
      error: error?.message || String(error),
    });
    writeJson(ledgerPath, ledger);
    ensureDir(path.join(runRoot, 'failures'));
    writeJson(path.join(runRoot, 'failures', 'orchestrator-failure.json'), {
      benchmark_id: opts.benchmarkId,
      failed_at: isoNow(),
      error: error?.stack || String(error),
    });
    throw error;
  } finally {
    if (!opts.keepServicesRunning) {
      stopChild(uma?.child);
      if (opts.force) {
        killPortsIfForced(true, PROC_PORTS);
      }
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
