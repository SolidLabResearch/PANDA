#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync, execFile } = require('child_process');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const { client: WebSocketClient } = require('websocket');
const {
  repoRoot,
  siblingDefaults,
  resolveRepoPath,
  ensureRepoExists,
} = require('./workspace_paths');

const ROOT = repoRoot;
const SCENARIO_DIR = path.join(ROOT, 'benchmarks', 'scenarios');
const RESULTS_ROOT = path.join(ROOT, 'benchmarks', 'results', 'runs');
const UMA_DIR = resolveRepoPath({
  cliValue: null,
  envVarName: 'UMA_REPO',
  defaultPath: siblingDefaults.umaRepo,
});
const WS_PROTOCOL = 'solid-stream-aggregator-protocol';

function parseArgs(argv) {
  const out = {
    mode: 'smoke',
    runs: 1,
    warmup: 0,
    replayerDuration: 120,
    queryWindow: 60,
    queryRegistrationDelay: 10,
    resume: false,
    force: false,
    retryFailed: false,
    onlyScenario: null,
    benchmarkId: null,
    continueOnFailure: false,
    pandaPort: 8080,
    pandaHttpUrl: 'http://localhost:8080/',
    pandaWsUrl: 'ws://localhost:8080/',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--mode') out.mode = next;
    if (key === '--runs') out.runs = Number(next);
    if (key === '--warmup') out.warmup = Number(next);
    if (key === '--replayer-duration') out.replayerDuration = Number(next);
    if (key === '--query-window') out.queryWindow = Number(next);
    if (key === '--query-registration-delay') out.queryRegistrationDelay = Number(next);
    if (key === '--resume') out.resume = true;
    if (key === '--force') out.force = true;
    if (key === '--retry-failed') out.retryFailed = true;
    if (key === '--only-scenario') out.onlyScenario = next;
    if (key === '--benchmark-id') out.benchmarkId = next;
    if (key === '--continue-on-failure') out.continueOnFailure = true;
    if (key === '--panda-port') out.pandaPort = Number(next);
    if (key === '--panda-http-url') out.pandaHttpUrl = next;
    if (key === '--panda-ws-url') out.pandaWsUrl = next;
  }
  if (!out.benchmarkId) {
    out.benchmarkId = `panda-live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow() {
  return new Date().toISOString();
}

function isoFromTimestampMs(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function isoFromNullableTimestampMs(timestampMs) {
  return Number.isFinite(timestampMs) ? isoFromTimestampMs(timestampMs) : null;
}

function addMsToIso(timestamp, ms) {
  if (!timestamp || !Number.isFinite(ms)) return null;
  return isoFromTimestampMs(Date.parse(timestamp) + ms);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function commandForDisplay(command, args) {
  return [command, ...args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg)].join(' ');
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
      if (Number(pid) === process.pid) continue;
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch (_) {
        // process may have exited
      }
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

function execFileLogged(command, args, options, logFile) {
  ensureDir(path.dirname(logFile));
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      fs.appendFileSync(logFile, [
        `$ ${commandForDisplay(command, args)}`,
        stdout || '',
        stderr || '',
        `[process_exit] code=${error?.code ?? 0} duration_ms=${(performance.now() - startedAt).toFixed(3)}`,
        '',
      ].join('\n'));
      if (error) {
        reject(new Error(`${commandForDisplay(command, args)} failed with code ${error.code}. See ${logFile}`));
        return;
      }
      resolve({ stdout, stderr, ms: performance.now() - startedAt });
    });
  });
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

function ensureFileExists(file) {
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '');
  }
}

function startReplayerLogWatcher(logFile, counters) {
  const onChange = () => {
    if (!fs.existsSync(logFile)) return;
    let text = '';
    try {
      text = fs.readFileSync(logFile, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      return;
    }
    counters.started = counters.started || text.includes('[BENCHMARK_REPLAYER] started');
    counters.completed = text.includes('[BENCHMARK_REPLAYER] completed');
    counters.posted = (text.match(/\[BENCHMARK_REPLAYER\] event_posted/g) || []).length;
  };
  fs.watchFile(logFile, { interval: 250 }, onChange);
  return () => {
    fs.unwatchFile(logFile, onChange);
  };
}

async function startUma(opts, runRoot, runId) {
  const logDir = path.join(runRoot, 'raw', 'uma-live-logs');
  ensureDir(logDir);
  const logFile = path.join(logDir, `uma-odrl-run-${runId}.log`);
  const startedAt = performance.now();
  const child = spawnLogged('corepack', ['yarn', 'start:odrl'], {
    cwd: UMA_DIR,
    env: process.env,
  }, logFile);
  await waitForHttp('http://localhost:4000/uma/.well-known/uma2-configuration', 120000);
  await waitForHttp('http://localhost:3000/', 120000);
  return {
    child,
    cssStatePath: path.join(runRoot, 'raw', 'css-meta-files'),
    umaLogFile: logFile,
    ms: performance.now() - startedAt,
  };
}

async function createContainersAndPolicies(scenario, cssStatePath, httpStatuses) {
  const startedContainersAt = performance.now();
  const dirs = [
    '',
    'alice',
    'alice/spo2',
    'alice/derived',
    'alice/derived/anomaly-alert',
  ];
  for (const dir of dirs) {
    ensureDir(path.join(cssStatePath, dir));
  }
  const containerUrls = [
    'http://localhost:3000/alice/spo2/',
    'http://localhost:3000/alice/derived/',
    'http://localhost:3000/alice/derived/anomaly-alert/',
  ];
  const policy = makeOdrlPolicy(scenario);
  const policyResponse = await fetch('http://localhost:4000/uma/policies', {
    method: 'POST',
    headers: {
      Authorization: 'WebID http%3A%2F%2Flocalhost%3A3000%2Falice%2Fprofile%2Fcard%23me',
      'Content-Type': 'text/turtle',
    },
    body: policy,
  });
  httpStatuses.push({ phase: 'policy_post', status: policyResponse.status, url: 'http://localhost:4000/uma/policies' });
  if (!(policyResponse.status === 201 || policyResponse.status === 409)) {
    const body = await policyResponse.text().catch(() => '');
    throw new Error(`ODRL policy write failed status=${policyResponse.status} body=${body}`);
  }
  for (const url of containerUrls) {
    const response = await fetchWithUma(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n',
    });
    httpStatuses.push({ phase: 'container_put', status: response.status, url });
    if (!(response.status >= 200 && response.status < 300) && response.status !== 409) {
      const body = await response.text().catch(() => '');
      throw new Error(`Container creation failed status=${response.status} url=${url} body=${body}`);
    }
  }
  const containerCreationMs = performance.now() - startedContainersAt;

  const startedMetaAt = performance.now();
  const metaFiles = new Map([
    ['alice/.meta', [
      '@prefix derived: <urn:npm:solid:derived-resources:> .',
      '',
      '<> derived:derivedResource [',
      '  derived:template "derived/latest";',
      '  derived:selector "http://localhost:3000/alice/spo2/*";',
      '  derived:filter "latest"',
      '].',
      '',
    ].join('\n')],
    ['alice/spo2/.meta', '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n'],
    ['alice/derived/.meta', '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n'],
    ['alice/derived/anomaly-alert/.meta', '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n'],
  ]);
  for (const [relativePath, content] of metaFiles) {
    fs.writeFileSync(path.join(cssStatePath, relativePath), content);
    const url = `http://localhost:3000/${relativePath}`;
    const response = await fetchWithUma(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: content,
    });
    httpStatuses.push({ phase: 'meta_put', status: response.status, url });
  }
  return {
    containerCreationMs,
    metaPolicyWriteMs: performance.now() - startedMetaAt,
    metaPaths: Array.from(metaFiles.keys()),
  };
}

async function fetchWithUma(url, init) {
  const state = fetchWithUma.state || { token: null };
  fetchWithUma.state = state;
  const headers = new Headers(init.headers || {});
  if (state.token) {
    headers.set('Authorization', `${state.token.token_type || 'Bearer'} ${state.token.access_token}`);
  }
  let response = await fetch(url, { ...init, headers });
  if (response.ok || (response.status !== 401 && response.status !== 403)) {
    return response;
  }
  const challenge = parseAuthenticateHeader(response.headers.get('WWW-Authenticate'));
  state.token = await exchangeToken(challenge.tokenEndpoint, challenge.ticket);
  headers.set('Authorization', `${state.token.token_type || 'Bearer'} ${state.token.access_token}`);
  return fetch(url, { ...init, headers });
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

async function exchangeToken(tokenEndpoint, ticket) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: encodeURIComponent('http://localhost:3000/alice/profile/card#me'),
      claim_token_format: 'urn:solidlab:uma:claims:formats:webid',
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`UMA token exchange failed status=${response.status} body=${body}`);
  return JSON.parse(body);
}

function defaultClaimForActor(actor) {
  if (actor === 'alice') return 'http://localhost:3000/alice/profile/card#me';
  if (actor === 'nurse') return process.env.PANDA_NURSE_CLAIM_TOKEN || 'http://localhost:3000/nurse/profile/card#me';
  if (actor === 'replayer') return process.env.PANDA_REPLAYER_CLAIM_TOKEN || 'http://localhost:3000/alice/profile/card#me';
  if (actor === 'panda') return process.env.PANDA_UMA_CLAIM_TOKEN || 'http://localhost:3000/bob/profile/card#me';
  return 'http://localhost:3000/alice/profile/card#me';
}

async function exchangeTokenForClaim(tokenEndpoint, ticket, claimToken) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: encodeURIComponent(claimToken),
      claim_token_format: 'urn:solidlab:uma:claims:formats:webid',
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`UMA token exchange failed status=${response.status} body=${body}`);
  return JSON.parse(body);
}

async function umaFetchMeasured(url, init = {}, actor = 'alice') {
  const metrics = {
    challenge_ms: null,
    token_exchange_ms: null,
    authorized_request_ms: null,
    total_ms: null,
    challenge_observed: false,
    authorized_status: null,
  };
  const totalStartedAt = performance.now();
  const challengeStartedAt = performance.now();
  const challengeResponse = await fetch(url, init);
  metrics.challenge_ms = performance.now() - challengeStartedAt;
  if (challengeResponse.ok) {
    metrics.total_ms = performance.now() - totalStartedAt;
    metrics.authorized_status = challengeResponse.status;
    return { response: challengeResponse, body: await challengeResponse.text().catch(() => ''), metrics };
  }
  if (challengeResponse.status !== 401 && challengeResponse.status !== 403) {
    const body = await challengeResponse.text().catch(() => '');
    metrics.total_ms = performance.now() - totalStartedAt;
    metrics.authorized_status = challengeResponse.status;
    const error = new Error(`Expected UMA challenge/denial for ${init.method || 'GET'} ${url}, got ${challengeResponse.status}: ${body}`);
    error.details = {
      status_code: challengeResponse.status,
      body_snippet: body.slice(0, 500),
      metrics,
      phase: 'challenge',
      uma_challenge_header_present: false,
    };
    throw error;
  }
  const authenticate = challengeResponse.headers.get('WWW-Authenticate');
  if (!/^UMA\s+/i.test(authenticate || '')) {
    const body = await challengeResponse.text().catch(() => '');
    metrics.total_ms = performance.now() - totalStartedAt;
    metrics.authorized_status = challengeResponse.status;
    const error = new Error(`Expected UMA WWW-Authenticate for ${url}, got status=${challengeResponse.status} header=${authenticate || 'none'} body=${body}`);
    error.details = {
      status_code: challengeResponse.status,
      body_snippet: body.slice(0, 500),
      metrics,
      phase: 'challenge',
      uma_challenge_header_present: false,
      www_authenticate: authenticate || null,
    };
    throw error;
  }
  metrics.challenge_observed = true;
  const challenge = parseAuthenticateHeader(authenticate);
  const tokenStartedAt = performance.now();
  const token = await exchangeTokenForClaim(challenge.tokenEndpoint, challenge.ticket, defaultClaimForActor(actor));
  metrics.token_exchange_ms = performance.now() - tokenStartedAt;
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `${token.token_type || 'Bearer'} ${token.access_token}`);
  const authorizedStartedAt = performance.now();
  const response = await fetch(url, { ...init, headers });
  metrics.authorized_request_ms = performance.now() - authorizedStartedAt;
  metrics.total_ms = performance.now() - totalStartedAt;
  metrics.authorized_status = response.status;
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    const error = new Error(`Authorized UMA request failed for ${url} actor=${actor} status=${response.status} body=${body}`);
    error.details = {
      status_code: response.status,
      body_snippet: body.slice(0, 500),
      metrics,
      phase: 'authorized_get',
      uma_challenge_header_present: true,
    };
    throw error;
  }
  return { response, body, metrics };
}

function makeOdrlPolicy(scenario) {
  const stream = scenario.target_css_resources.stream_container_url;
  const latest = scenario.target_css_resources.derived_latest_url;
  const alert = scenario.target_css_resources.alert_container_url;
  const derived = 'http://localhost:3000/alice/derived/';
  const metaTargets = [
    'http://localhost:3000/alice/.meta',
    'http://localhost:3000/alice/spo2/.meta',
    'http://localhost:3000/alice/derived/.meta',
    'http://localhost:3000/alice/derived/anomaly-alert/.meta',
  ];
  const owner = 'http://localhost:3000/alice/profile/card#me';
  const metaPermissions = metaTargets.map((target, index) => `
ex:writeMeta${index} a odrl:Permission ;
  odrl:target <${target}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action odrl:create, odrl:append, odrl:write, odrl:read .
`).join('\n');
  return `
@prefix odrl: <http://www.w3.org/ns/odrl/2/> .
@prefix ex: <http://example.org/panda-live-benchmark#> .

ex:policy a odrl:Agreement ;
  odrl:uid ex:policy ;
  odrl:permission ex:readLatest, ex:readStream, ex:writeStream, ex:writeDerived, ex:writeAlert${metaTargets.map((_, index) => `, ex:writeMeta${index}`).join('')} .

ex:readLatest a odrl:Permission ;
  odrl:target <${latest}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action odrl:read .

ex:readStream a odrl:Permission ;
  odrl:target <${stream}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action odrl:read .

ex:writeStream a odrl:Permission ;
  odrl:target <${stream}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action odrl:create, odrl:append, odrl:write .

ex:writeDerived a odrl:Permission ;
  odrl:target <${derived}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action odrl:create, odrl:append, odrl:write, odrl:read .

ex:writeAlert a odrl:Permission ;
  odrl:target <${alert}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action odrl:create, odrl:append, odrl:write, odrl:read .
${metaPermissions}
`.trim();
}

async function startPanda(runRoot, runId) {
  const logFile = path.join(runRoot, 'raw', `panda-run-${runId}.log`);
  const startedAt = performance.now();
  const child = spawnLogged('npm', ['run', 'start-monitoring'], {
    cwd: ROOT,
    env: {
      ...process.env,
      BENCHMARK_TIMING: '1',
      PANDA_EXPECTED_PROPERTY_IRI: 'https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2',
    },
  }, logFile);
  await waitForHttp('http://localhost:8080/', 120000);
  return { child, logFile, ms: performance.now() - startedAt };
}

function renderTemplate(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(values[key] ?? ''));
}

async function runReplayer(scenario, opts, runRoot, benchmarkRunId, counters) {
  const command = renderTemplate(scenario.replayer_command, {
    replayer_duration_seconds: opts.replayerDuration,
    benchmark_run_id: benchmarkRunId,
  });
  const logFile = path.join(runRoot, 'raw', `replayer-${benchmarkRunId}.log`);
  ensureFileExists(logFile);
  const [cmd, ...args] = command.split(/\s+/);
  const stopWatcher = startReplayerLogWatcher(logFile, counters);
  const startedAtPerf = performance.now();
  const startedAtWall = isoNow();
  const child = spawnLogged(cmd, args, { cwd: ROOT, env: process.env }, logFile);
  const exitInfoPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({
        code,
        signal,
        exitedAtPerf: performance.now(),
        exitedAtWall: isoNow(),
      });
    });
  });
  child.stdout?.on?.('data', () => {});
  return {
    child,
    logFile,
    command,
    stopWatcher,
    startedAtPerf,
    startedAtWall,
    exitInfoPromise,
  };
}

async function waitForReplayerActive(counters, timeoutMs) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (counters.started && counters.posted > 0) return;
    await sleep(250);
  }
  throw new Error('Timed out waiting for replayer to actively post stream data');
}

function createQueryRegistrationSession(scenario, opts, benchmarkRunId, waitMode = 'full_window') {
  const ws = new WebSocketClient();
  let settled = false;
  let ackResolved = false;
  let socketConnection = null;
  let resolveAck;
  let rejectAck;
  let resolveResult;
  let rejectResult;
  const ackPromise = new Promise((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const timeout = setTimeout(() => {
    const error = new Error('Timed out waiting for benchmark query registration/result');
    if (!ackResolved) {
      ackResolved = true;
      rejectAck(error);
    }
    if (!settled) {
      settled = true;
      rejectResult(error);
    }
    try { ws.abort(); } catch (_) {}
  }, Math.max(180000, (opts.replayerDuration + 90) * 1000));
  const result = {
    querySendAt: 0,
    querySendWall: null,
    registeredQuery: null,
    wsConnectStartAt: performance.now(),
    wsConnectAt: 0,
    wsConnectWall: null,
    ackAt: 0,
    ackWall: null,
    firstResultAt: 0,
    firstResultWall: null,
    ack: null,
    message: null,
    resultCount: 0,
    earlyResultCount: 0,
    earlyResultIgnoredReasonsSummary: {},
    earlyResultIgnoredSamples: [],
    acceptedResultEvidence: null,
    firstAnyResultEvidence: null,
    lastIgnoredPartialEvidence: null,
    resultSizeBytes: 0,
    clientResultDelivery: {
      mechanism: 'websocket_push',
      client_poll_interval_ms: null,
      client_poll_attempts_until_result: null,
    },
  };
  const closeSocket = () => {
    clearTimeout(timeout);
    try { socketConnection?.close(); } catch (_) {}
    try { ws.abort(); } catch (_) {}
  };
  const fail = (error) => {
    clearTimeout(timeout);
    if (!ackResolved) {
      ackResolved = true;
      rejectAck(error);
    }
    if (!settled) {
      settled = true;
      rejectResult(error);
    }
  };
  const settle = () => {
    closeSocket();
    if (!settled) {
      settled = true;
      resolveResult(result);
    }
  };
  const recordIgnoredResult = (reason, parsed, now, evidence = null) => {
    result.earlyResultCount += 1;
    result.earlyResultIgnoredReasonsSummary[reason] = (result.earlyResultIgnoredReasonsSummary[reason] || 0) + 1;
    if (reason === 'partial_window') {
      result.lastIgnoredPartialEvidence = evidence;
    }
    if (result.earlyResultIgnoredSamples.length < 10) {
      result.earlyResultIgnoredSamples.push({
        reason,
        validation_reason: evidence?.validationReason ?? null,
        elapsed_since_query_register_ms: result.querySendAt ? now - result.querySendAt : null,
        event_count: evidence?.eventCount ?? null,
        first_event_timestamp: isoFromNullableTimestampMs(evidence?.firstEventTimestampMs),
        last_event_timestamp: isoFromNullableTimestampMs(evidence?.lastEventTimestampMs),
        event_time_span_ms: evidence?.eventTimeSpanMs ?? null,
        benchmark_run_id: parsed?.benchmark_timing?.benchmark_run_id || null,
        has_benchmark_timing: Boolean(parsed?.benchmark_timing),
        has_aggregation_event: Object.prototype.hasOwnProperty.call(parsed || {}, 'aggregation_event'),
        aggregation_window_from: parsed?.aggregation_window_from || null,
        aggregation_window_to: parsed?.aggregation_window_to || null,
      });
    }
  };
  ws.on('connectFailed', fail);
  ws.on('connect', (conn) => {
    socketConnection = conn;
    result.wsConnectAt = performance.now();
    result.wsConnectWall = isoNow();
    conn.on('error', fail);
    conn.on('message', (message) => {
      if (message.type !== 'utf8') return;
      let parsed;
      try {
        parsed = JSON.parse(message.utf8Data);
      } catch (_) {
        parsed = { raw: message.utf8Data };
      }
      if (parsed.type === 'benchmark_ack') {
        result.ackAt = performance.now();
        result.ackWall = isoNow();
        result.ack = parsed;
        if (!ackResolved) {
          ackResolved = true;
          resolveAck(result);
        }
        if (waitMode === 'ack_only') {
          settle();
        }
        return;
      }
      const timingRunId = parsed?.benchmark_timing?.benchmark_run_id;
      const now = performance.now();
      if (result.querySendAt && now < result.querySendAt) {
        recordIgnoredResult('before_query_registration', parsed, now);
        return;
      }
      if (timingRunId && timingRunId !== benchmarkRunId) {
        recordIgnoredResult('wrong_benchmark_run_id', parsed, now);
        return;
      }
      if (!timingRunId) {
        recordIgnoredResult('stale_result', parsed, now);
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(parsed || {}, 'aggregation_event')) {
        recordIgnoredResult('invalid_output_shape', parsed, now);
        return;
      }
      const evidence = buildResultWindowEvidence(parsed, now, result.querySendAt, opts.queryWindow);
      if (!result.firstAnyResultEvidence) {
        result.firstAnyResultEvidence = evidence;
      }
      const aggregationText = typeof parsed?.aggregation_event === 'string' ? parsed.aggregation_event : '';
      const isAnomaly = /SPO2_LOW|LowValueDetected|alert/i.test(aggregationText);
      const requiresAnomaly = waitMode === 'first_anomaly' || waitMode === 'full_window_anomaly';
      if (requiresAnomaly && !isAnomaly) {
        recordIgnoredResult('non_anomaly_result', parsed, now, evidence);
        return;
      }
      if (waitMode === 'full_window' || waitMode === 'full_window_anomaly') {
        if (!evidence.provesFullWindow) {
          recordIgnoredResult('partial_window', parsed, now, evidence);
          return;
        }
      }
      if (!result.message) {
        result.resultCount += 1;
        result.firstResultAt = now;
        result.firstResultWall = isoNow();
        result.message = parsed;
        result.acceptedResultEvidence = evidence;
        result.resultSizeBytes = Buffer.byteLength(message.utf8Data);
        settle();
      }
    });
    const query = renderTemplate(scenario.panda_query_payload.query_template, {
      benchmark_run_id: benchmarkRunId.replace(/-/g, '_'),
      query_window_ms: opts.queryWindow * 1000,
    });
    result.registeredQuery = query;
    const payload = {
      query,
      rules: scenario.panda_query_payload.rules,
      type: scenario.panda_query_payload.type,
      actor_webid: scenario.panda_query_payload.actor_webid,
      correlation_id: benchmarkRunId,
      benchmark_run_id: benchmarkRunId,
    };
    result.querySendAt = performance.now();
    result.querySendWall = isoNow();
    conn.sendUTF(JSON.stringify(payload));
  });
  ws.connect(opts.pandaWsUrl || 'ws://localhost:8080/', WS_PROTOCOL);
  return {
    ackPromise,
    resultPromise,
    cancel: closeSocket,
  };
}

function registerQueryAndWait(scenario, opts, benchmarkRunId, waitMode = 'full_window') {
  return createQueryRegistrationSession(scenario, opts, benchmarkRunId, waitMode).resultPromise;
}

function parseNs(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
}

function nsDiffMs(a, b) {
  return a && b ? Number(b - a) / 1_000_000 : null;
}

function finiteNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildResultWindowEvidence(parsed, now, querySendAt, queryWindowSeconds) {
  const timing = parsed?.benchmark_timing || {};
  const metrics = timing.metrics || {};
  const requiredSpanMs = queryWindowSeconds * 1000;
  const eventCount = finiteNumberOrNull(metrics.rsp_stream_event_count_after_query_registration);
  const firstEventTimestampMs = finiteNumberOrNull(metrics.rsp_first_event_timestamp_ms);
  const lastEventTimestampMs = finiteNumberOrNull(metrics.rsp_last_event_timestamp_ms);
  const eventTimeSpanMs = firstEventTimestampMs !== null
    && lastEventTimestampMs !== null
    && lastEventTimestampMs >= firstEventTimestampMs
    ? lastEventTimestampMs - firstEventTimestampMs
    : null;

  const rspWindowMetadata = parsed?.rsp_window_metadata || null;
  const rspWindowMetadataSpanMs = rspWindowMetadata?.source === 'rsp_engine_epoch_ms'
    ? finiteNumberOrNull(rspWindowMetadata.event_time_span_ms)
    : null;
  const rspWindowMetadataProvesFullWindow = rspWindowMetadataSpanMs !== null && rspWindowMetadataSpanMs >= requiredSpanMs;

  const serverRegistered = parseNs(timing.query_registered_at_ns);
  const serverFirstAdd = parseNs(timing.first_stream_event_added_at_ns || timing.first_stream_event_at_ns);
  const firstPostQueryEventDelayMs = nsDiffMs(serverRegistered, serverFirstAdd);
  const wallClockSinceQueryRegisterMs = querySendAt ? now - querySendAt : null;
  const wallClockSinceFirstPostQueryEventMs = Number.isFinite(wallClockSinceQueryRegisterMs)
    && Number.isFinite(firstPostQueryEventDelayMs)
    ? Math.max(0, wallClockSinceQueryRegisterMs - firstPostQueryEventDelayMs)
    : null;

  let validationReason = 'unable_to_prove_full_window';
  let provesFullWindow = false;
  if (eventTimeSpanMs !== null && eventTimeSpanMs >= requiredSpanMs) {
    validationReason = 'event_time_span_full_window';
    provesFullWindow = true;
  } else if (rspWindowMetadataProvesFullWindow) {
    validationReason = 'rsp_engine_window_metadata_full_window';
    provesFullWindow = true;
  } else if (eventTimeSpanMs !== null) {
    validationReason = 'event_time_span_below_window';
  }

  return {
    eventCount,
    firstEventTimestampMs,
    lastEventTimestampMs,
    eventTimeSpanMs,
    wallClockSinceQueryRegisterMs,
    wallClockSinceFirstPostQueryEventMs,
    validationReason,
    provesFullWindow,
    rspWindowMetadataSource: rspWindowMetadata?.source || null,
    rspWindowMetadataSpanMs,
  };
}

function acceptedResultDebugFields(evidence) {
  return {
    accepted_result_event_count: evidence?.eventCount ?? null,
    accepted_result_first_event_timestamp: isoFromNullableTimestampMs(evidence?.firstEventTimestampMs),
    accepted_result_last_event_timestamp: isoFromNullableTimestampMs(evidence?.lastEventTimestampMs),
    accepted_result_event_time_span_ms: evidence?.eventTimeSpanMs ?? null,
    accepted_result_wall_clock_since_query_register_ms: evidence?.wallClockSinceQueryRegisterMs ?? null,
    accepted_result_wall_clock_since_first_post_query_event_ms: evidence?.wallClockSinceFirstPostQueryEventMs ?? null,
    accepted_result_validation_reason: evidence?.validationReason ?? 'unable_to_prove_full_window',
    accepted_result_rsp_window_metadata_source: evidence?.rspWindowMetadataSource ?? null,
    accepted_result_rsp_window_metadata_span_ms: evidence?.rspWindowMetadataSpanMs ?? null,
  };
}

function firstAnyResultDebugFields(evidence) {
  return {
    rsp_first_any_result_event_count: evidence?.eventCount ?? null,
    rsp_first_any_result_event_time_span_ms: evidence?.eventTimeSpanMs ?? null,
    rsp_first_any_result_classification: evidence?.validationReason ?? null,
  };
}

function ignoredResultDebugFields(evidence) {
  return {
    last_ignored_event_count: evidence?.eventCount ?? null,
    last_ignored_first_event_timestamp: isoFromNullableTimestampMs(evidence?.firstEventTimestampMs),
    last_ignored_last_event_timestamp: isoFromNullableTimestampMs(evidence?.lastEventTimestampMs),
    last_ignored_event_time_span_ms: evidence?.eventTimeSpanMs ?? null,
    last_ignored_validation_reason: evidence?.validationReason ?? null,
  };
}

function aggregateDebugFieldNames(row) {
  return Object.keys(row).filter((key) => (
    key.startsWith('accepted_result_') || key.startsWith('last_ignored_') || key.startsWith('rsp_first_any_result_')
  ) && typeof row[key] === 'number' && Number.isFinite(row[key]));
}

function aggregationWindowDebugFields(message, prefix) {
  const from = message?.aggregation_window_from || null;
  const to = message?.aggregation_window_to || null;
  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;
  return {
    [`${prefix}_aggregation_window_from`]: from,
    [`${prefix}_aggregation_window_to`]: to,
    [`${prefix}_aggregation_window_span_ms`]: Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.max(0, toMs - fromMs) : null,
  };
}

function metricDefinitions() {
  const unavailable = (name, notes) => ({
    unit: 'ms',
    type: 'unavailable',
    start_event: 'unavailable',
    end_event: 'unavailable',
    interpretation: `${name} is not measured by the current benchmark instrumentation.`,
    critical_path: false,
    notes,
  });
  return {
    css_uma_startup_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'css_uma_start_start',
      end_event: 'css_uma_ready',
      interpretation: 'Wall-clock time for the external CSS/UMA stack to become HTTP-ready before the benchmark query phase.',
      critical_path: false,
      notes: 'Setup time before live query registration; not part of the query-to-result critical path.',
    },
    container_creation_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'container_creation_start',
      end_event: 'containers_created',
      interpretation: 'Wall-clock setup time to create the benchmark Solid containers.',
      critical_path: false,
      notes: 'Setup time before live query registration.',
    },
    meta_policy_write_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'meta_policy_write_start',
      end_event: 'meta_policies_written',
      interpretation: 'Wall-clock setup time to write metadata resources after container setup.',
      critical_path: false,
      notes: 'Setup time before live query registration.',
    },
    panda_startup_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'panda_start_start',
      end_event: 'panda_ready',
      interpretation: 'Wall-clock time for PANDA to become HTTP-ready.',
      critical_path: false,
      notes: 'Setup time before live replay and query registration.',
    },
    accepted_result_event_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'query_register_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Number of events in the accepted result evidence used to prove a full query window.',
      critical_path: true,
      notes: 'Debug evidence for the accepted result, not an independent benchmark outcome.',
    },
    accepted_result_event_time_span_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'rsp_first_event_timestamp_ms',
      end_event: 'rsp_last_event_timestamp_ms',
      interpretation: 'Event-time span covered by the accepted result evidence.',
      critical_path: true,
      notes: 'Derived from the first and last event timestamps observed in the accepted result evidence.',
    },
    accepted_result_wall_clock_since_query_register_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'query_register_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Wall-clock time from query registration send to receipt of the accepted result.',
      critical_path: true,
      notes: 'Debug evidence that mirrors the client-observed query-to-result latency.',
    },
    accepted_result_wall_clock_since_first_post_query_event_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'rsp_first_event_after_query_register_added',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Wall-clock remainder after subtracting the server-side delay to the first post-registration stream event.',
      critical_path: true,
      notes: 'Derived debug remainder used to explain why the accepted result arrived when it did.',
    },
    accepted_result_rsp_window_metadata_span_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'rsp_engine_window_metadata_start',
      end_event: 'rsp_engine_window_metadata_end',
      interpretation: 'Event-time span reported by explicit RSP window metadata for the accepted result.',
      critical_path: true,
      notes: 'Only present when the benchmark accepts explicit RSP window metadata as proof of a full window.',
    },
    accepted_result_aggregation_window_span_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'accepted_result_aggregation_window_from',
      end_event: 'accepted_result_aggregation_window_to',
      interpretation: 'Span between aggregation_window_from and aggregation_window_to in the accepted result payload.',
      critical_path: true,
      notes: 'This is the RSP result payload window span, which can differ from cumulative post-registration event-span evidence.',
    },
    query_registered_to_result_received_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'query_register_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Client-observed wall-clock duration from sending the live query registration request over WebSocket until the first valid result accepted by the benchmark client.',
      critical_path: true,
      notes: 'Includes the live RSP window wait. Despite the historical name, the start event is the client query registration send.',
    },
    rsp_first_post_registration_event_added_to_result_received_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'rsp_first_event_after_query_register_added',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Observed query-to-result duration minus the server-side delay from query registration to the first stream event added after registration.',
      critical_path: true,
      notes: 'Derived from one client-side duration and one server-side duration; useful for separating post-first-event wait from event arrival delay.',
    },
    window_adjusted_observed_latency_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'query_register_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Client-observed query-to-result latency minus the nominal RSP window size.',
      critical_path: true,
      notes: 'This is observed overhead beyond the configured window, not total PANDA processing overhead.',
    },
    expected_window_wait_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'query_register_start',
      end_event: 'nominal_query_window_close',
      interpretation: 'Configured query window in milliseconds.',
      critical_path: true,
      notes: 'Derived from query_window_seconds * 1000.',
    },
    replayer_start_to_query_register_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'replayer_start',
      end_event: 'query_register_start',
      interpretation: 'Wall-clock delay between replayer start and live query registration.',
      critical_path: false,
      notes: 'Controls overlap between the live stream and query registration.',
    },
    replayer_total_runtime_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'replayer_start',
      end_event: 'replayer_completed',
      interpretation: 'Wall-clock runtime of the live stream replayer.',
      critical_path: false,
      notes: 'Overlaps the query critical path; it is not sequential processing after query registration.',
    },
    replayer_events_posted_before_query_registration: {
      unit: 'count',
      type: 'counter',
      start_event: 'replayer_start',
      end_event: 'query_register_start',
      interpretation: 'Number of stream events posted before the benchmark client sent query registration.',
      critical_path: false,
      notes: 'Live-stream overlap counter.',
    },
    replayer_events_posted_after_query_registration: {
      unit: 'count',
      type: 'counter',
      start_event: 'query_register_start',
      end_event: 'replayer_completed',
      interpretation: 'Number of stream events posted after the benchmark client sent query registration.',
      critical_path: false,
      notes: 'Live-stream overlap counter.',
    },
    query_registration_ack_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'query_register_start',
      end_event: 'query_register_ack',
      interpretation: 'Client-observed duration from query registration send to benchmark acknowledgement receive.',
      critical_path: true,
      notes: 'The acknowledgement is sent after PANDA registers the query; it can arrive after stream events have already started being processed.',
    },
    rsp_first_event_after_query_registration_delay_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'query_registered_at_server',
      end_event: 'rsp_first_event_after_query_register_added',
      interpretation: 'Server-side duration from query registration in PANDA to the first stream event added to the RSP engine after that registration.',
      critical_path: true,
      notes: 'Measured with PANDA process hrtime. This is event arrival/ingestion overlap, not the RSP window duration.',
    },
    rdf_parse_ms: {
      unit: 'ms',
      type: 'cumulative',
      start_event: 'stream_event_parse_start',
      end_event: 'stream_event_parse_end',
      interpretation: 'Cumulative RDF parse time across stream events processed by the query.',
      critical_path: false,
      notes: 'Sum of many small parse durations; not a wall-clock span.',
    },
    rdf_quads_parsed_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'stream_event_parse_start',
      end_event: 'stream_event_parse_end',
      interpretation: 'Total RDF quads parsed from stream events processed by the query.',
      critical_path: false,
      notes: 'Counter.',
    },
    source_events_with_current_benchmark_run_id_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'stream_event_parse_start',
      end_event: 'stream_event_parse_end',
      interpretation: 'Number of parsed source-event payloads whose quads contain the current benchmark_run_id.',
      critical_path: false,
      notes: 'Event-level run-isolation evidence captured inside PANDA before timestamp validation.',
    },
    source_events_without_benchmark_run_id_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'stream_event_parse_start',
      end_event: 'stream_event_parse_end',
      interpretation: 'Number of parsed source-event payloads where no benchmark_run_id marker was detectable.',
      critical_path: false,
      notes: 'Event-level run-isolation evidence. Container listings usually land here.',
    },
    source_events_with_other_benchmark_run_id_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'stream_event_parse_start',
      end_event: 'stream_event_parse_end',
      interpretation: 'Number of parsed source-event payloads that appear to reference a different benchmark run.',
      critical_path: false,
      notes: 'Event-level run-isolation evidence.',
    },
    rsp_engine_construct_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'rsp_engine_construct_start',
      end_event: 'rsp_engine_construct_end',
      interpretation: 'Wall-clock duration to construct the RSP engine for the registered query.',
      critical_path: true,
      notes: 'Measured inside PANDA during query registration.',
    },
    rsp_register_emitter_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'rsp_register_emitter_start',
      end_event: 'rsp_emitter_registered',
      interpretation: 'Wall-clock duration to register the RSP result emitter.',
      critical_path: true,
      notes: 'Measured inside PANDA during query registration.',
    },
    rsp_event_add_count_total: {
      unit: 'count',
      type: 'counter',
      start_event: 'rsp_event_add_start',
      end_event: 'rsp_event_add_end',
      interpretation: 'Number of RDF quads added to the RSP stream for this query timing context.',
      critical_path: false,
      notes: 'Counter across live event ingestion.',
    },
    rsp_events_added_with_current_benchmark_run_id_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'rsp_event_add_start',
      end_event: 'rsp_event_add_end',
      interpretation: 'Number of timestamp-valid source events added to the RSP engine that carried the current benchmark_run_id.',
      critical_path: false,
      notes: 'Event-level run-isolation evidence for accepted-window provenance.',
    },
    rsp_events_added_without_benchmark_run_id_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'rsp_event_add_start',
      end_event: 'rsp_event_add_end',
      interpretation: 'Number of timestamp-valid source events added to the RSP engine without a detectable benchmark_run_id.',
      critical_path: false,
      notes: 'Event-level run-isolation evidence for accepted-window provenance.',
    },
    rsp_events_added_with_other_benchmark_run_id_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'rsp_event_add_start',
      end_event: 'rsp_event_add_end',
      interpretation: 'Number of timestamp-valid source events added to the RSP engine that appear to belong to a different benchmark run.',
      critical_path: false,
      notes: 'Event-level run-isolation evidence for accepted-window provenance.',
    },
    rsp_event_add_count_after_query_registration: {
      unit: 'count',
      type: 'counter',
      start_event: 'query_registered_at_server',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Number of RSP event-add operations recorded after query registration.',
      critical_path: false,
      notes: 'Counter across live event ingestion.',
    },
    rsp_event_add_total_ms: {
      unit: 'ms',
      type: 'cumulative',
      start_event: 'rsp_event_add_start',
      end_event: 'rsp_event_add_end',
      interpretation: 'Cumulative time spent in RSP stream add calls.',
      critical_path: false,
      notes: 'Sum of many small add-call durations; not a wall-clock span and overlaps the live window wait.',
    },
    rsp_event_add_mean_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'rsp_event_add_start',
      end_event: 'rsp_event_add_end',
      interpretation: 'Mean duration of recorded RSP stream add calls.',
      critical_path: false,
      notes: 'Derived from rsp_event_add_total_ms / rsp_event_add_count_total.',
    },
    rsp_event_add_p95_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'rsp_event_add_start',
      end_event: 'rsp_event_add_end',
      interpretation: 'P95 duration of recorded RSP stream add calls.',
      critical_path: false,
      notes: 'Derived from individual RSP event-add durations.',
    },
    rsp_first_any_result_emit_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'query_registered_at_server',
      end_event: 'rsp_first_any_result_emit_ms',
      interpretation: 'Server-side duration from query registration to the first RSP evaluation/result emission after registration.',
      critical_path: false,
      notes: 'This can be a partial-window result and is not the 60-second window wait used for valid benchmark latency.',
    },
    rsp_first_any_result_event_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'query_register_start',
      end_event: 'rsp_first_any_result_emit_ms',
      interpretation: 'Number of events in the first-any-result evidence emitted after query registration.',
      critical_path: true,
      notes: 'Debug evidence for the first emitted result, which may still be partial-window.',
    },
    rsp_first_any_result_event_time_span_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'rsp_first_event_timestamp_ms',
      end_event: 'rsp_last_event_timestamp_ms',
      interpretation: 'Event-time span covered by the first-any-result evidence.',
      critical_path: true,
      notes: 'Derived from the first and last event timestamps observed in the first-any-result evidence.',
    },
    rsp_query_eval_ms: unavailable('rsp_query_eval_ms', 'RSP query evaluation CPU time is not instrumented separately from RSP event add and result emission.'),
    rsp_first_any_result_emit_processing_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'rsp_first_any_result_emit_processing_start',
      end_event: 'rsp_first_any_result_emit_processing_end',
      interpretation: 'Processing duration inside the first RSP result callback before the result object is sent to PANDA WebSocket relay.',
      critical_path: false,
      notes: 'This is an internal first-result processing duration, not a duration from query registration.',
    },
    result_emit_to_client_receive_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'server_first_valid_result_sent',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Approximate client-observation remainder after subtracting PANDA server-side query_registered_at_server-to-server_sent duration from client-observed query_register_start-to-result duration.',
      critical_path: true,
      notes: 'Results are delivered by WebSocket push. This remainder includes client query send to server registration and other client-observed overhead, so it is not an isolated WebSocket network-latency measurement.',
    },
    result_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'query_register_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Number of valid benchmark results accepted by the client before closing the WebSocket.',
      critical_path: true,
      notes: 'The smoke benchmark stops at the first valid result, so this is normally 1.',
    },
    result_size_bytes: {
      unit: 'bytes',
      type: 'counter',
      start_event: 'client_first_valid_result_received',
      end_event: 'client_first_valid_result_received',
      interpretation: 'UTF-8 byte size of the first valid result message received by the client.',
      critical_path: false,
      notes: 'Counter-like payload size.',
    },
    early_result_count_ignored: {
      unit: 'count',
      type: 'counter',
      start_event: 'query_register_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Number of result-like messages ignored before accepting the first valid benchmark result.',
      critical_path: false,
      notes: 'In this live-window benchmark, most ignored results are expected to be partial-window emissions before the configured window duration has elapsed.',
    },
    uma_initial_challenge_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'uma_challenge_start',
      end_event: 'uma_challenge_end',
      interpretation: 'Duration of the first tokenless UMA request that obtains an authorization challenge.',
      critical_path: true,
      notes: 'Measured inside PANDA authorization prefetch during query registration when UMA flow is needed.',
    },
    uma_token_exchange_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'uma_token_exchange_start',
      end_event: 'uma_token_exchange_end',
      interpretation: 'Duration of the first UMA ticket-to-RPT token exchange.',
      critical_path: true,
      notes: 'Measured inside PANDA authorization prefetch during query registration when UMA flow is needed.',
    },
    authorized_retry_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'authorized_retry_start',
      end_event: 'authorized_retry_end',
      interpretation: 'Duration of the first protected resource retry after UMA authorization succeeds.',
      critical_path: true,
      notes: 'Measured inside PANDA authorization prefetch during query registration when UMA flow is needed.',
    },
    odrl_policy_eval_ms: unavailable('odrl_policy_eval_ms', 'ODRL policy evaluation CPU time is not currently emitted by the UMA service for this benchmark.'),
    last_ignored_event_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'query_register_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Number of result-like messages ignored before accepting the first valid benchmark result.',
      critical_path: false,
      notes: 'Debug evidence for ignored partial-window results, not an independent benchmark outcome.',
    },
    last_ignored_event_time_span_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'rsp_first_event_timestamp_ms',
      end_event: 'rsp_last_event_timestamp_ms',
      interpretation: 'Event-time span covered by the last ignored partial-window result evidence.',
      critical_path: false,
      notes: 'Derived from the first and last event timestamps observed in the last ignored result evidence.',
    },
    ws_connect_ms: { unit: 'ms', type: 'direct', start_event: 'ws_connect_start', end_event: 'ws_connect', interpretation: 'Client-observed WebSocket connection time to PANDA.', critical_path: true, notes: 'Measured by the benchmark client.' },
    query_registration_send_to_ack_ms: { unit: 'ms', type: 'direct', start_event: 'query_register_start', end_event: 'query_register_ack', interpretation: 'Query registration send-to-ack latency.', critical_path: true, notes: 'Alias for the protected e2e scenario.' },
    query_registration_to_first_rsp_output_ms: { unit: 'ms', type: 'direct', start_event: 'query_register_start', end_event: 'client_first_valid_result_received', interpretation: 'Query registration to the first accepted current-run full-window RSP output carrying anomaly evidence.', critical_path: true, notes: 'Protected RSP-gated anomaly benchmark metric.' },
    replayer_first_observation_write_ms: { unit: 'ms', type: 'direct', start_event: 'replayer_first_observation_write_start', end_event: 'replayer_first_observation_write_done', interpretation: 'First Replayer SpO2 observation UMA write duration.', critical_path: true, notes: 'Parsed from Replayer log.' },
    replayer_observation_write_to_panda_receive_ms: { unit: 'ms', type: 'direct', start_event: 'replayer_first_observation_written', end_event: 'panda_first_receive', interpretation: 'Delay from Replayer source write completion to PANDA receiving/processing the observation.', critical_path: true, notes: 'Derived from log timestamps when observable.' },
    panda_receive_to_anomaly_detected_ms: { unit: 'ms', type: 'direct', start_event: 'panda_first_receive', end_event: 'panda_anomaly_detected', interpretation: 'PANDA receive to rule anomaly detection latency.', critical_path: true, notes: 'Derived from PANDA validation logs when observable.' },
    anomaly_detected_to_panda_pod_write_start_ms: { unit: 'ms', type: 'direct', start_event: 'panda_anomaly_detected', end_event: 'panda_alert_write_start', interpretation: 'Delay from anomaly detection to PANDA alert pod write start.', critical_path: true, notes: 'Derived from PANDA validation logs.' },
    rsp_result_to_panda_anomaly_pod_write_ms: { unit: 'ms', type: 'direct', start_event: 'client_first_valid_result_received', end_event: 'panda_alert_write_success', interpretation: 'Delay from the first accepted RSP output observed by the benchmark client to PANDA alert Pod write success.', critical_path: true, notes: 'Bridges the accepted RSP result and the resulting PANDA materialization write.' },
    rsp_output_to_panda_alert_write_start_ms: { unit: 'ms', type: 'direct', start_event: 'rsp_result_timestamp', end_event: 'panda_alert_write_start', interpretation: 'Delay from RSP result to when PANDA begins writing the alert.', critical_path: true, notes: 'Captures PANDA processing and alert assembly time.' },
    rsp_output_to_panda_alert_write_success_ms: { unit: 'ms', type: 'direct', start_event: 'rsp_result_timestamp', end_event: 'panda_alert_write_success', interpretation: 'Total delay from RSP result to PANDA alert Pod write completion.', critical_path: true, notes: 'Includes PANDA processing, write, and UMA authorization.' },
    panda_anomaly_pod_write_uma_challenge_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_uma_challenge_start', end_event: 'panda_alert_write_uma_challenge_end', interpretation: 'PANDA alert write UMA challenge latency.', critical_path: true, notes: 'Available when PANDA emits timing; otherwise null.' },
    panda_anomaly_pod_write_token_exchange_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_token_exchange_start', end_event: 'panda_alert_write_token_exchange_end', interpretation: 'PANDA alert write UMA token exchange latency.', critical_path: true, notes: 'Available when PANDA emits timing; otherwise null.' },
    panda_anomaly_pod_write_authorized_request_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_request_start', end_event: 'panda_alert_write_response', interpretation: 'PANDA authorized alert POST latency.', critical_path: true, notes: 'Derived from PANDA alert write logs when observable.' },
    panda_anomaly_pod_write_total_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_start', end_event: 'panda_alert_write_success', interpretation: 'PANDA alert materialization total duration.', critical_path: true, notes: 'Derived from PANDA logs.' },
    panda_alert_write_success_to_alice_poll_function_start_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_success', end_event: 'alice_poll_function_start', interpretation: 'Delay between PANDA alert write success and when pollLatestAnomalyForRun() is called.', critical_path: true, notes: 'If this is non-zero, polling starts late. If zero, polling starts immediately after PANDA completes.' },
    panda_alert_write_success_to_alice_first_poll_attempt_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_success', end_event: 'alice_first_http_attempt', interpretation: 'Delay between PANDA alert write success and when Alice makes the first HTTP request for latest-anomaly.', critical_path: true, notes: 'Separates function-call overhead from actual polling start. Should be close to panda_alert_write_success_to_alice_poll_function_start_ms if loop is tight.' },
    alice_first_poll_attempt_to_latest_anomaly_success_ms: { unit: 'ms', type: 'direct', start_event: 'alice_first_http_attempt', end_event: 'alice_latest_anomaly_read_success', interpretation: 'Duration from first HTTP poll attempt to successful read of fresh latest-anomaly.', critical_path: true, notes: 'Measures CSS/derived-resources propagation lag plus polling retry time. If all attempts are stale/404, this is the CSS lag.' },
    alice_latest_read_poll_loop_duration_ms: { unit: 'ms', type: 'direct', start_event: 'alice_poll_function_start', end_event: 'alice_latest_anomaly_read_success', interpretation: 'Total duration of the polling loop from function entry to success.', critical_path: true, notes: 'Alias: alice_latest_read_poll_duration_ms' },
    alice_latest_read_poll_function_start_ms: { unit: 'ms', type: 'timestamp', start_event: null, end_event: null, interpretation: 'Absolute Unix timestamp (ms) when pollLatestAnomalyForRun() function starts.', critical_path: false, notes: 'Raw timestamp for diagnostic analysis.' },
    alice_latest_read_first_attempt_ms: { unit: 'ms', type: 'timestamp', start_event: null, end_event: null, interpretation: 'Absolute Unix timestamp (ms) when the first HTTP request is made to latest-anomaly.', critical_path: false, notes: 'Raw timestamp for diagnostic analysis. Should be very close to alice_latest_read_poll_function_start_ms.' },
    alice_latest_read_poll_attempt_count: { unit: 'count', type: 'direct', start_event: null, end_event: null, interpretation: 'Number of HTTP attempts made before obtaining fresh latest-anomaly content.', critical_path: false, notes: 'If count > 1, indicates CSS/derived-resources took multiple polling cycles to generate fresh content.' },
    panda_alert_write_success_to_alice_latest_read_start_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_success', end_event: 'alice_latest_anomaly_poll_start', interpretation: '[LEGACY] Delay from PANDA alert write success to when polling for latest-anomaly begins.', critical_path: true, notes: 'Exposes CSS/file-system sync time before polling starts. Use panda_alert_write_success_to_alice_poll_function_start_ms instead.' },
    panda_alert_write_success_to_alice_latest_read_success_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_success', end_event: 'alice_latest_anomaly_read_success', interpretation: '[LEGACY] Total delay from PANDA alert write success to Alice latest-anomaly read success.', critical_path: true, notes: 'Includes CSS update lag and polling time. Use new decomposed metrics for detailed analysis.' },
    alice_latest_read_poll_duration_ms: { unit: 'ms', type: 'direct', start_event: 'alice_latest_anomaly_poll_start', end_event: 'alice_latest_anomaly_read_success', interpretation: '[LEGACY] Duration of the polling loop for latest-anomaly until success.', critical_path: true, notes: 'Does not include CSS update lag before polling starts. Use alice_latest_read_poll_loop_duration_ms instead.' },
    anomaly_written_to_latest_anomaly_available_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_success', end_event: 'alice_latest_anomaly_read_success', interpretation: 'Delay from PANDA alert write success to Alice latest-anomaly availability.', critical_path: true, notes: 'Measured by polling latest-anomaly through UMA.' },
    // NEW KEY DIAGNOSTIC METRICS
    panda_alert_write_success_to_first_alice_attempt_start_ms: { unit: 'ms', type: 'direct', start_event: 'panda_alert_write_success', end_event: 'alice_first_http_attempt', interpretation: 'Delay between PANDA alert write success and when Alice makes the first HTTP request to latest-anomaly. KEY METRIC for Scenario A vs B diagnosis.', critical_path: true, notes: 'If ~0-100ms, polling starts immediately (Scenario B). If > 1000ms, polling starts late (Scenario A).' },
    first_alice_attempt_start_to_latest_success_ms: { unit: 'ms', type: 'direct', start_event: 'alice_first_http_attempt', end_event: 'alice_latest_anomaly_read_success', interpretation: 'Duration from first Alice HTTP poll attempt to successful read of fresh latest-anomaly. Measures CSS/derived-resources propagation lag plus polling retry time.', critical_path: true, notes: 'If many stale/404 attempts precede success, CSS is the bottleneck (Scenario B). If single attempt succeeds, UMA overhead dominates.' },
    latest_success_attempt_count: { unit: 'count', type: 'counter', start_event: null, end_event: null, interpretation: 'Number of Alice poll attempts that returned fresh latest-anomaly content. Normally 1 for fast success.', critical_path: false, notes: 'If > 1, indicates retries were needed.' },
    latest_stale_200_count: { unit: 'count', type: 'counter', start_event: null, end_event: null, interpretation: 'Number of Alice HTTP 200 responses with stale/invalid latest-anomaly content (wrong benchmark_run_id, missing RSP proof, etc).', critical_path: false, notes: 'High count indicates CSS/derived-resources took time to generate fresh content (Scenario B indicator).' },
    latest_404_count: { unit: 'count', type: 'counter', start_event: null, end_event: null, interpretation: 'Number of Alice HTTP 404 responses for latest-anomaly. Indicates resource did not exist yet on CSS.', critical_path: false, notes: 'Early 404s followed by 200 indicates CSS creating and then updating the resource (Scenario B indicator).' },
    latest_uma_error_count: { unit: 'count', type: 'counter', start_event: null, end_event: null, interpretation: 'Number of Alice poll attempts that failed due to UMA authorization errors or network issues.', critical_path: false, notes: 'Should be 0 if UMA is working correctly.' },
    alice_latest_anomaly_uma_challenge_ms: { unit: 'ms', type: 'direct', start_event: 'alice_latest_anomaly_challenge_start', end_event: 'alice_latest_anomaly_challenge_end', interpretation: 'Alice latest-anomaly UMA challenge latency.', critical_path: true, notes: 'Measured by benchmark as Alice consumption.' },
    alice_latest_anomaly_token_exchange_ms: { unit: 'ms', type: 'direct', start_event: 'alice_latest_anomaly_token_start', end_event: 'alice_latest_anomaly_token_end', interpretation: 'Alice latest-anomaly UMA token exchange latency.', critical_path: true, notes: 'Measured by benchmark as Alice consumption.' },
    alice_latest_anomaly_authorized_get_ms: { unit: 'ms', type: 'direct', start_event: 'alice_latest_anomaly_authorized_get_start', end_event: 'alice_latest_anomaly_authorized_get_end', interpretation: 'Alice latest-anomaly authorized GET latency.', critical_path: true, notes: 'Measured by benchmark as Alice consumption.' },
    alice_latest_anomaly_total_read_ms: { unit: 'ms', type: 'direct', start_event: 'alice_latest_anomaly_read_start', end_event: 'alice_latest_anomaly_read_success', interpretation: 'Alice latest-anomaly full UMA read latency.', critical_path: true, notes: 'Measured by benchmark as Alice consumption.' },
    nurse_latest_anomaly_notify_or_read_ms: { unit: 'ms', type: 'direct', start_event: 'nurse_latest_anomaly_start', end_event: 'nurse_latest_anomaly_success', interpretation: 'Nurse/caregiver notification or UMA read latency.', critical_path: false, notes: 'Null unless nurse read is explicitly enabled and authorized.' },
    end_to_end_replayer_to_rsp_output_ms: { unit: 'ms', type: 'direct', start_event: 'replayer_first_observation_written', end_event: 'client_first_valid_result_received', interpretation: 'End-to-end latency from the first Replayer write to the first accepted current-run full-window RSP output.', critical_path: true, notes: 'The RSP-gated latency floor for the protected anomaly benchmark.' },
    rsp_output_to_alice_latest_anomaly_success_ms: { unit: 'ms', type: 'direct', start_event: 'rsp_result_timestamp', end_event: 'alice_latest_anomaly_read_success', interpretation: 'End-to-end latency from RSP output to Alice latest-anomaly read success.', critical_path: true, notes: 'Includes PANDA processing, alert write, CSS update lag, and polling.' },
    end_to_end_replayer_to_alice_latest_anomaly_ms: { unit: 'ms', type: 'direct', start_event: 'replayer_first_observation_written', end_event: 'alice_latest_anomaly_read_success', interpretation: 'End-to-end protected flow latency from Replayer source write to Alice latest-anomaly read.', critical_path: true, notes: 'Core e2e scenario metric.' },
    end_to_end_replayer_to_nurse_notification_ms: { unit: 'ms', type: 'direct', start_event: 'replayer_first_observation_written', end_event: 'nurse_latest_anomaly_success', interpretation: 'End-to-end protected flow latency to nurse/caregiver notification/read.', critical_path: false, notes: 'Null unless nurse read/subscription is implemented.' },
    odrl_decision_latency_ms: unavailable('odrl_decision_latency_ms', 'Current UMA logs do not expose a structured ODRL decision latency field.'),
  };
}

function attachMetricDefinitions(raw) {
  const definitions = metricDefinitions();
  raw.metric_definitions = {};
  const metricNames = new Set([
    ...Object.keys(raw.metrics || {}),
    ...aggregateDebugFieldNames(raw),
  ]);
  for (const metric of metricNames) {
    raw.metric_definitions[metric] = definitions[metric] || {
      unit: 'unknown',
      type: 'unavailable',
      start_event: 'unavailable',
      end_event: 'unavailable',
      interpretation: `${metric} has no explicit definition in the benchmark runner.`,
      critical_path: false,
      notes: 'Add a metric definition before interpreting or aggregating this metric.',
    };
  }
}

function buildCriticalPathTimeline(events, queryResult, timing) {
  const base = queryResult.querySendAt;
  const timeline = [];
  const add = (event, tRelativeMs, timestamp, notes) => {
    if (!Number.isFinite(tRelativeMs) || !timestamp) return;
    timeline.push({ event, t_relative_ms: tRelativeMs, timestamp, notes });
  };
  const addLocal = (event, notes) => {
    const mark = events[event];
    if (!mark || !base) return;
    add(event, mark.t - base, mark.timestamp, notes || mark.notes || '');
  };

  addLocal('css_uma_start_start', 'Local benchmark runner event; negative values occur before query registration.');
  addLocal('css_uma_ready', 'CSS/UMA stack ready before query registration.');
  addLocal('containers_created', 'Solid containers created before query registration.');
  addLocal('meta_policies_written', 'Metadata and policy setup completed before query registration.');
  addLocal('panda_start_start', 'PANDA startup initiated before query registration.');
  addLocal('panda_ready', 'PANDA HTTP server ready before query registration.');
  addLocal('replayer_start', 'Live stream replayer started before query registration and continues while query is registered.');
  add('query_register_start', 0, queryResult.querySendWall, 'Benchmark client sent the live query registration WebSocket message.');
  if (queryResult.ackAt && queryResult.ackWall) {
    add('query_register_ack', queryResult.ackAt - queryResult.querySendAt, queryResult.ackWall, 'Benchmark client received PANDA query registration acknowledgement.');
  }

  const serverRegistered = parseNs(timing.query_registered_at_ns);
  const serverEvents = [
    ['rsp_first_event_after_query_register_added', parseNs(timing.first_stream_event_added_at_ns || timing.first_stream_event_at_ns), 'First server-side stream event added to the RSP engine after query registration.'],
    ['rsp_first_any_result_emit_ms', parseNs(timing.first_result_emitted_at_ns), 'First server-side RSP result emission after query registration; may be a partial-window result.'],
    ['server_first_valid_result_sent', parseNs(timing.server_sent_at_ns), 'PANDA WebSocket relay sent the accepted result to the benchmark client.'],
  ];
  for (const [event, ns, notes] of serverEvents) {
    const rel = nsDiffMs(serverRegistered, ns);
    add(event, rel, addMsToIso(queryResult.querySendWall, rel), `${notes} Relative time is computed from PANDA server query_registered_at_ns.`);
  }

  if (queryResult.firstResultAt && queryResult.firstResultWall) {
    add('client_first_valid_result_received', queryResult.firstResultAt - queryResult.querySendAt, queryResult.firstResultWall, 'Benchmark client accepted the first result whose event-time span or explicit RSP window metadata proves a complete configured window.');
  }
  addLocal('replayer_completed', 'Live stream replayer completed after the query result was received.');
  return timeline.sort((a, b) => a.t_relative_ms - b.t_relative_ms);
}

function validateOutput(raw, scenario, replayerCounters) {
  const details = {};
  const m = raw.metrics;
  const requiredMarkers = scenario.required_log_markers || [];
  const missingLogMarkers = requiredMarkers.filter((marker) => !raw.log_markers_found.includes(marker));
  const acceptedFullWindow = raw.accepted_result_validation_reason === 'event_time_span_full_window'
    || raw.accepted_result_validation_reason === 'rsp_engine_window_metadata_full_window';
  const passed = Boolean(
    raw.status === 'complete'
    && raw.sequence.css_uma_started
    && raw.sequence.containers_created
    && raw.sequence.meta_policies_written
    && raw.sequence.panda_started
    && raw.sequence.replayer_started
    && raw.sequence.query_registered
    && raw.sequence.rsp_first_event_after_query_registered
    && raw.sequence.client_result_received
    && replayerCounters.posted > 0
    && m.query_registered_to_result_received_ms > 0
    && m.rsp_first_post_registration_event_added_to_result_received_ms > 0
    && Number.isFinite(m.window_adjusted_observed_latency_ms)
    && m.result_count > 0
    && acceptedFullWindow
    && m.replayer_events_posted_after_query_registration > 0
    && missingLogMarkers.length === 0
    && raw.query_registration_delay_seconds + raw.query_window_seconds < raw.replayer_duration_seconds
  );
  if (!passed) {
    details.reason = 'One or more live benchmark validity checks failed.';
    if (missingLogMarkers.length > 0) details.missing_log_markers = missingLogMarkers;
    if (!acceptedFullWindow) details.accepted_result_validation_reason = raw.accepted_result_validation_reason || null;
  }
  return { passed, details };
}

function parseKeyValueLine(line) {
  const out = {};
  for (const match of line.matchAll(/([a-zA-Z0-9_]+)=("[^"]*"|[^ ]+)/g)) {
    out[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return out;
}

function firstIsoFromLine(line) {
  const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  return match ? match[0] : null;
}

function parseReplayerProof(logFile) {
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const eventLine = text.split(/\r?\n/).find((line) => line.includes('[BENCHMARK_REPLAYER] event_posted'));
  if (!eventLine) return { wrote_spo2: false };
  const kv = parseKeyValueLine(eventLine);
  return {
    wrote_spo2: true,
    first_event_line: eventLine,
    first_write_ms: Number(kv.total_ms),
    first_write_timestamp: kv.timestamp || firstIsoFromLine(eventLine),
    uma_challenge_observed: kv.uma_challenge_observed === 'true',
    target: kv.target || null,
  };
}

function parsePandaAlertProof(logFile, benchmarkRunId = null) {
  const allLines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/) : [];
  const lines = benchmarkRunId
    ? allLines.filter((line) => line.includes(benchmarkRunId) || !/\[MEASURE\]\[ALERT\]|\[VALIDATION\]\[ALERT\]|\[MEASURE\]\[RULE\]|\[MEASURE\]\[RSP\]/.test(line))
    : allLines;
  const receiveLine = lines.find((line) => line.includes('[VALIDATION][INGEST] event_added_to_rsp_engine') || line.includes('[MEASURE][RSP] event_added'));
  const detectedLine = lines.find((line) => line.includes('[MEASURE][RULE] matched'));
  const writeStartLine = lines.find((line) => line.includes('[MEASURE][ALERT] write_start'));
  const requestLine = lines.find((line) => line.includes('[VALIDATION][ALERT] write_request_sent'));
  const rspProofLine = lines.find((line) => {
    if (!line.includes('[VALIDATION][ALERT][RSP_PROOF]')) return false;
    if (!benchmarkRunId) return true;
    return parseKeyValueLine(line).benchmark_run_id === benchmarkRunId;
  });
  const responseLine = lines.find((line) => line.includes('[VALIDATION][ALERT] write_response_received'));
  const successLine = lines.find((line) => line.includes('[MEASURE][ALERT] write_success'));
  const rspProofKv = rspProofLine ? parseKeyValueLine(rspProofLine) : {};
  const responseKv = responseLine ? parseKeyValueLine(responseLine) : {};
  const successKv = successLine ? parseKeyValueLine(successLine) : {};
  const toMs = (line) => {
    const iso = firstIsoFromLine(line || '');
    return iso ? Date.parse(iso) : null;
  };
  return {
    panda_wrote_anomaly_alert: Boolean(successLine),
    receive_ms: toMs(receiveLine),
    detected_ms: toMs(detectedLine),
    write_start_ms: toMs(writeStartLine),
    request_ms: toMs(requestLine),
    response_ms: toMs(responseLine),
    success_ms: toMs(successLine),
    status: responseKv.status ? Number(responseKv.status) : null,
    resource: successKv.resource || null,
    rsp_proof: {
      line: rspProofLine || null,
      benchmark_run_id: rspProofKv.benchmark_run_id || null,
      derived_from: rspProofKv.derived_from || null,
      rsp_query_hash: rspProofKv.rsp_query_hash || null,
      rsp_window_start: rspProofKv.rsp_window_start || null,
      rsp_window_end: rspProofKv.rsp_window_end || null,
      rsp_result_timestamp: rspProofKv.rsp_result_timestamp || null,
    },
    lines: {
      receive: receiveLine || null,
      detected: detectedLine || null,
      write_start: writeStartLine || null,
      rsp_proof: rspProofLine || null,
      response: responseLine || null,
      success: successLine || null,
    },
  };
}

function listCandidatePandaLogFiles() {
  const benchmarkResultsDir = path.join(ROOT, 'benchmark-results');
  const discovered = fs.existsSync(benchmarkResultsDir)
    ? fs.readdirSync(benchmarkResultsDir)
      .filter((file) => /^panda-.*\.log$|^panda-.*\.stdout\.log$/.test(file))
      .map((file) => path.join(benchmarkResultsDir, file))
    : [];
  return [
    process.env.PANDA_MONITOR_LOG_FILE,
    process.env.PANDA_LOG_FILE,
    ...discovered,
  ].filter(Boolean);
}

function findCurrentRunRspProof(logFile, benchmarkRunId) {
  if (!logFile || !fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes('[VALIDATION][ALERT][RSP_PROOF]')) continue;
    const kv = parseKeyValueLine(line);
    if (kv.benchmark_run_id !== benchmarkRunId) continue;
    return {
      line,
      benchmark_run_id: kv.benchmark_run_id || null,
      derived_from: kv.derived_from || null,
      rsp_query_hash: kv.rsp_query_hash || null,
      rsp_window_start: kv.rsp_window_start || null,
      rsp_window_end: kv.rsp_window_end || null,
      rsp_result_timestamp: kv.rsp_result_timestamp || null,
      log_timestamp: firstIsoFromLine(line),
    };
  }
  return null;
}

async function waitForCurrentRunRspProof(logFiles, benchmarkRunId, timeoutMs) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    for (const logFile of logFiles) {
      const proof = findCurrentRunRspProof(logFile, benchmarkRunId);
      if (proof) {
        return proof;
      }
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for current-run RSP proof for benchmark_run_id=${benchmarkRunId}`);
}

function resolveReadableOdrlLogFile() {
  const candidates = [
    process.env.PANDA_UMA_ODRL_LOG_FILE,
    process.env.UMA_ODRL_LOG_FILE,
  ].filter(Boolean);
  const latestEnvFile = path.join(ROOT, 'benchmark-results', 'uma-live-logs', 'latest-odrl-log.env');
  if (!candidates.length && fs.existsSync(latestEnvFile)) {
    const latestEnv = fs.readFileSync(latestEnvFile, 'utf8');
    const match = latestEnv.match(/(?:PANDA_UMA_ODRL_LOG_FILE|UMA_ODRL_LOG_FILE)="([^"]+)"/);
    if (match?.[1]) candidates.push(match[1]);
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch (_) {
      // keep trying
    }
  }
  return '';
}

function createBenchmarkOdrlLink(benchmarkId, logFile) {
  if (!logFile) return '';
  const linkPath = path.join(ROOT, 'benchmark-results', `uma-odrl-${benchmarkId}.log`);
  if (path.resolve(linkPath) === path.resolve(logFile)) {
    return logFile;
  }
  fs.rmSync(linkPath, { force: true });
  try {
    fs.symlinkSync(logFile, linkPath);
  } catch (_) {
    fs.copyFileSync(logFile, linkPath);
  }
  return linkPath;
}

function odrlProofFromText(text, logFile) {
  const lines = String(text || '').split(/\r?\n/);
  const firstMatch = (pattern) => lines.find((line) => pattern.test(line)) || null;
  return {
    log_files: logFile ? [logFile] : [],
    odrl_authorizer: text.includes('OdrlAuthorizer'),
    evaluating_request: text.includes('Evaluating Request [S R AR]'),
    matching_policy_rules: /Matching policy rules/i.test(text),
    odrl_decision: /ODRL decision/i.test(text),
    false_decision: /ODRL decision.*false|decision.*false/i.test(text),
    true_decision: /ODRL decision.*true|decision.*true/i.test(text),
    replayer_spo2_write: /alice\/spo2/i.test(text),
    panda_alert_write: /alice\/derived\/anomaly-alert/i.test(text),
    alice_latest_read: /alice\/derived\/latest-anomaly/i.test(text),
    proof_lines: {
      odrl_authorizer: firstMatch(/OdrlAuthorizer/),
      evaluating_request: firstMatch(/Evaluating Request \[S R AR\]/),
      matching_policy_rules: firstMatch(/Matching policy rules/i),
      false_decision: firstMatch(/ODRL decision.*false|decision.*false/i),
      true_decision: firstMatch(/ODRL decision.*true|decision.*true/i),
    },
  };
}

function readOdrlLogDelta(logFile, startOffset) {
  const text = fs.readFileSync(logFile, 'utf8');
  return {
    endOffset: Buffer.byteLength(text),
    delta: startOffset > 0 ? text.slice(startOffset) : text,
  };
}

function assertLiveOdrlProof(logFile, startOffset, label) {
  const { delta, endOffset } = readOdrlLogDelta(logFile, startOffset);
  const proof = odrlProofFromText(delta, logFile);
  const missing = ['odrl_authorizer', 'evaluating_request', 'matching_policy_rules', 'odrl_decision', 'false_decision', 'true_decision']
    .filter((key) => !proof[key]);
  if (missing.length) {
    throw new Error(
      `${label} failed: live ODRL proof missing from ${logFile}. Missing markers: ${missing.join(', ')}`
    );
  }
  return { proof, endOffset };
}

async function assertProtectedTargets(targets, httpStatuses) {
  const proof = [];
  for (const url of targets) {
    const response = await fetch(url);
    const www = response.headers.get('WWW-Authenticate') || '';
    const body = await response.text().catch(() => '');
    const hasUma = /^UMA\s+/i.test(www);
    httpStatuses.push({ phase: 'protected_resource_probe', status: response.status, url, www_authenticate: www || null });
    if (response.status === 200) {
      throw new Error(`Protected target is public HTTP 200 without UMA: ${url}`);
    }
    if (!(response.status === 401 || response.status === 403)) {
      throw new Error(`Protected target ${url} returned ${response.status}, expected UMA challenge or denial. Body=${body}`);
    }
    proof.push({ url, status: response.status, uma_challenge: hasUma, denied: !hasUma });
  }
  return proof;
}

function evaluateContentFreshness(body, benchmarkRunId, expectedRspQueryHash = null) {
  // Returns an object describing why content is or isn't fresh
  const result = {
    is_fresh: false,
    reasons: [],
  };
  
  if (typeof body !== 'string') {
    result.reasons.push('body_not_string');
    return result;
  }
  
  if (body.length === 0) {
    result.reasons.push('body_empty');
    return result;
  }
  
  // Check for 404-like responses
  if (/404|not found|resource not found/i.test(body)) {
    result.reasons.push('resource_not_found');
    return result;
  }
  
  // Check if contains current benchmarkRunId
  if (!body.includes(benchmarkRunId)) {
    result.reasons.push('missing_current_benchmark_run_id');
    const benchmarkRunIdPattern = /benchmark[_-]run[_-]id["\s:]*([a-z0-9-]+)/i;
    const match = body.match(benchmarkRunIdPattern);
    if (match) {
      result.stale_benchmark_run_id = match[1];
      result.reasons.push('contains_different_benchmark_run_id');
    }
    return result;
  }
  
  // Check for derivedFrom = "rsp-query-result"
  if (!/derivedFrom[^\\n]*"rsp-query-result"/i.test(body)) {
    result.reasons.push('missing_derived_from_rsp_query_result');
    return result;
  }
  
  // Check for rspQueryHash
  const rspQueryHashMatch = body.match(/rspQueryHash["\s:]*([a-f0-9]+)/i);
  if (!rspQueryHashMatch) {
    result.reasons.push('missing_rsp_query_hash');
    return result;
  }
  const foundRspQueryHash = rspQueryHashMatch[1];
  if (expectedRspQueryHash && foundRspQueryHash !== expectedRspQueryHash) {
    result.reasons.push('rsp_query_hash_mismatch');
    result.expected_rsp_query_hash = expectedRspQueryHash;
    result.found_rsp_query_hash = foundRspQueryHash;
    return result;
  }
  
  // Check for RSP window metadata
  if (!/rspWindowStart/i.test(body)) {
    result.reasons.push('missing_rsp_window_start');
    return result;
  }
  if (!/rspWindowEnd/i.test(body)) {
    result.reasons.push('missing_rsp_window_end');
    return result;
  }
  if (!/rspResultTimestamp/i.test(body)) {
    result.reasons.push('missing_rsp_result_timestamp');
    return result;
  }
  
  // All checks passed
  result.is_fresh = true;
  return result;
}

function classifyLatencyGap(metrics, latestDiagnostics, pandaAlertSuccessMs) {
  // Classify the latency gap based on evidence, not inference
  const classification = {
    classification: 'unknown',
    evidence: {},
    confidence: 'low',
  };
  
  const alice_first_attempt_start_ms = latestDiagnostics.alice_first_attempt_start_ms;
  const alice_first_attempt_to_success_ms = metrics?.first_alice_attempt_start_to_latest_success_ms;
  const alice_total_attempts = metrics?.latest_success_attempt_count || 0;
  const alice_stale_200_count = metrics?.latest_stale_200_count || 0;
  const alice_404_count = metrics?.latest_404_count || 0;
  const alice_uma_error_count = metrics?.latest_uma_error_count || 0;
  
  const panda_to_first_attempt_ms = metrics?.panda_alert_write_success_to_first_alice_attempt_start_ms;
  
  classification.evidence = {
    panda_alert_success_ms: pandaAlertSuccessMs,
    alice_first_attempt_start_ms: alice_first_attempt_start_ms,
    panda_to_first_attempt_ms: panda_to_first_attempt_ms,
    first_attempt_to_success_ms: alice_first_attempt_to_success_ms,
    total_attempts: alice_total_attempts,
    stale_200_count: alice_stale_200_count,
    not_found_404_count: alice_404_count,
    uma_error_count: alice_uma_error_count,
  };
  
  // Check if PANDA alert was actually written
  if (!pandaAlertSuccessMs) {
    classification.classification = 'panda_alert_write_missing';
    classification.confidence = 'high';
    return classification;
  }
  
  // Check if polling starts very late
  if (panda_to_first_attempt_ms && panda_to_first_attempt_ms > 5000) {
    classification.classification = 'benchmark_control_flow_delay';
    classification.evidence.reason = 'polling_starts_late_after_panda_alert';
    classification.confidence = 'high';
    return classification;
  }
  
  // Check if polling starts immediately but gets many stale responses
  if (panda_to_first_attempt_ms && panda_to_first_attempt_ms < 500) {
    // Polling started immediately after PANDA
    if (alice_first_attempt_to_success_ms && alice_first_attempt_to_success_ms > 15000) {
      // But took a long time to get fresh content
      if (alice_stale_200_count > 0 || alice_404_count > 0) {
        // And we have evidence of stale/404 responses
        classification.classification = 'derived_visibility_lag';
        classification.evidence.reason = 'repeated_stale_or_404_responses_after_immediate_polling_start';
        classification.evidence.stale_or_404_responses = alice_stale_200_count + alice_404_count;
        classification.confidence = 'high';
        return classification;
      }
    }
  }
  
  // Check if the gap is mostly UMA overhead
  if (alice_total_attempts === 1 && alice_first_attempt_to_success_ms && alice_first_attempt_to_success_ms < 5000) {
    // Single successful attempt in < 5s
    const uma_total_breakdown = (latestDiagnostics.alice_attempt_history?.[0]?.alice_uma_challenge_ms || 0)
      + (latestDiagnostics.alice_attempt_history?.[0]?.alice_uma_token_exchange_ms || 0)
      + (latestDiagnostics.alice_attempt_history?.[0]?.alice_uma_authorized_get_ms || 0);
    if (uma_total_breakdown > 2000) {
      classification.classification = 'uma_read_overhead';
      classification.evidence.reason = 'single_attempt_success_with_significant_uma_overhead';
      classification.evidence.uma_breakdown_ms = uma_total_breakdown;
      classification.confidence = 'medium';
      return classification;
    }
  }
  
  // Default
  if (alice_total_attempts > 1) {
    classification.classification = 'derived_visibility_lag';
    classification.evidence.reason = 'multiple_attempts_needed_for_success';
    classification.confidence = 'medium';
  } else {
    classification.classification = 'unknown';
    classification.confidence = 'low';
  }
  
  return classification;
}

function latestAnomalyContainsRspProof(body, benchmarkRunId, expectedRspQueryHash = null) {
  const hasPredicateValue = (predicateLocalName, expectedValue = null) => {
    const pattern = expectedValue
      ? new RegExp(`${predicateLocalName}[^\\n]*"${expectedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i')
      : new RegExp(`${predicateLocalName}[^\\n]*"`, 'i');
    return pattern.test(body);
  };
  if (typeof body !== 'string' || !body.includes(benchmarkRunId)) return false;
  if (!hasPredicateValue('derivedFrom', 'rsp-query-result')) return false;
  if (!hasPredicateValue('rspQueryHash')) return false;
  if (!/rspWindowStart/i.test(body) || !/rspWindowEnd/i.test(body)) return false;
  if (!/rspResultTimestamp/i.test(body)) return false;
  if (expectedRspQueryHash && !body.includes(expectedRspQueryHash)) return false;
  return true;
}

async function pollLatestAnomalyForRun(url, benchmarkRunId, timeoutMs, expectedRspQueryHash = null) {
  const startedAt = performance.now();
  const alice_poll_function_start_ms = Date.now();
  const alice_poll_function_start_iso = new Date(alice_poll_function_start_ms).toISOString();
  
  let lastBody = '';
  let lastMetrics = null;
  let lastStatusCode = null;
  let attempts = 0;
  let alice_first_attempt_start_ms = null;
  let alice_first_attempt_start_iso = null;
  
  const alice_attempt_history = [];
  
  while (performance.now() - startedAt < timeoutMs) {
    attempts += 1;
    
    // Capture FIRST attempt timestamp BEFORE making the HTTP request
    const alice_this_attempt_start_ms = Date.now();
    const alice_this_attempt_start_iso = new Date(alice_this_attempt_start_ms).toISOString();
    
    if (attempts === 1) {
      alice_first_attempt_start_ms = alice_this_attempt_start_ms;
      alice_first_attempt_start_iso = alice_this_attempt_start_iso;
    }
    
    try {
      const read = await umaFetchMeasured(url, { method: 'GET', headers: { Accept: 'text/turtle,text/plain,*/*' } }, 'alice');
      const alice_this_attempt_finish_ms = Date.now();
      lastBody = read.body;
      lastMetrics = read.metrics;
      lastStatusCode = read.response.status;
      
      // Evaluate freshness of this response
      const isFresh = read.response.status === 200 && latestAnomalyContainsRspProof(read.body, benchmarkRunId, expectedRspQueryHash);
      const contentValidation = evaluateContentFreshness(read.body, benchmarkRunId, expectedRspQueryHash);
      
      // Determine freshness verdict
      let freshness_verdict = isFresh ? 'fresh' : 'stale_or_error';
      if (lastStatusCode === 404) {
        freshness_verdict = 'not_found';
      } else if (lastStatusCode !== 200 && lastStatusCode !== 404) {
        freshness_verdict = 'http_error';
      }
      
      alice_attempt_history.push({
        alice_attempt_number: attempts,
        alice_attempt_started_at_ms: alice_this_attempt_start_ms,
        alice_attempt_started_at_iso: alice_this_attempt_start_iso,
        alice_attempt_finished_at_ms: alice_this_attempt_finish_ms,
        alice_attempt_duration_ms: alice_this_attempt_finish_ms - alice_this_attempt_start_ms,
        alice_uma_challenge_ms: read.metrics?.challenge_ms ?? null,
        alice_uma_token_exchange_ms: read.metrics?.token_exchange_ms ?? null,
        alice_uma_authorized_get_ms: read.metrics?.authorized_request_ms ?? null,
        alice_final_status_code: read.response.status,
        alice_freshness_verdict: freshness_verdict,
        alice_content_validation: contentValidation,
      });
      
      if (isFresh) {
        return {
          ...read,
          alice_total_attempts: attempts,
          alice_total_loop_duration_ms: performance.now() - startedAt,
          alice_poll_function_start_iso: alice_poll_function_start_iso,
          alice_poll_function_start_ms: alice_poll_function_start_ms,
          alice_first_attempt_start_ms: alice_first_attempt_start_ms,
          alice_first_attempt_start_iso: alice_first_attempt_start_iso,
          alice_first_attempt_to_success_ms: alice_this_attempt_finish_ms - alice_first_attempt_start_ms,
          alice_attempt_history: alice_attempt_history,
          rsp_proof_verified: true,
        };
      }
    } catch (error) {
      const alice_this_attempt_finish_ms = Date.now();
      const details = error?.details || {};
      lastBody = details.body_snippet || '';
      lastMetrics = details.metrics || null;
      lastStatusCode = details.status_code ?? null;
      
      alice_attempt_history.push({
        alice_attempt_number: attempts,
        alice_attempt_started_at_ms: alice_this_attempt_start_ms,
        alice_attempt_started_at_iso: alice_this_attempt_start_iso,
        alice_attempt_finished_at_ms: alice_this_attempt_finish_ms,
        alice_attempt_duration_ms: alice_this_attempt_finish_ms - alice_this_attempt_start_ms,
        alice_uma_challenge_ms: lastMetrics?.challenge_ms ?? null,
        alice_uma_token_exchange_ms: lastMetrics?.token_exchange_ms ?? null,
        alice_uma_authorized_get_ms: lastMetrics?.authorized_request_ms ?? null,
        alice_final_status_code: lastStatusCode,
        alice_freshness_verdict: 'uma_error',
        alice_content_validation: { error: details.error_message || 'HTTP error' },
      });
    }
    await sleep(500);
  }
  
  const error = new Error(`latest-anomaly did not contain current-run RSP-derived proof for benchmark_run_id=${benchmarkRunId} within ${timeoutMs}ms. Last status=${lastStatusCode} last body=${lastBody.slice(0, 500)}`);
  error.details = {
    alice_total_attempts: attempts,
    alice_total_loop_duration_ms: performance.now() - startedAt,
    alice_final_status_code: lastStatusCode,
    alice_body_snippet: lastBody.slice(0, 500),
    alice_poll_function_start_iso: alice_poll_function_start_iso,
    alice_poll_function_start_ms: alice_poll_function_start_ms,
    alice_first_attempt_start_ms: alice_first_attempt_start_ms,
    alice_first_attempt_start_iso: alice_first_attempt_start_iso,
    alice_first_to_timeout_ms: alice_first_attempt_start_ms ? Date.now() - alice_first_attempt_start_ms : null,
    alice_attempt_history: alice_attempt_history,
    freshness_proven: false,
    rsp_proof_verified: false,
  };
  throw error;
}

async function runDerivedAnomalyScenario(scenario, opts, runRoot, runId, phase) {
  const isWarmup = phase === 'warmup';
  const benchmarkRunId = `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : runId}-${randomUUID()}`;
  const rawDir = isWarmup ? path.join(runRoot, 'warmup') : path.join(runRoot, 'raw');
  const failureDir = isWarmup ? path.join(runRoot, 'failures', 'warmup') : path.join(runRoot, 'failures');
  ensureDir(rawDir);
  ensureDir(failureDir);
  const rawPath = path.join(rawDir, `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : `run-${runId}`}.json`);
  const failurePath = path.join(failureDir, `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : `run-${runId}`}.json`);
  const httpStatuses = [];
  const sequence = {};
  const raw = {
    benchmark_id: opts.benchmarkId,
    benchmark_run_id: benchmarkRunId,
    git_commit: safeGitCommit(),
    node_version: process.version,
    scenario_id: scenario.scenario_id,
    scenario_file_path: scenario.__scenario_file || null,
    run_id: runId,
    phase,
    mode: opts.mode,
    deployment_mode: 'external_css_uma_panda',
    query_window_seconds: scenario.query_window_seconds || opts.queryWindow,
    replayer_duration_seconds: scenario.replayer_duration_seconds || opts.replayerDuration,
    query_registration_delay_seconds: scenario.query_registration_delay_after_replayer_start_seconds || 0,
    started_at: isoNow(),
    completed_at: null,
    status: 'running',
    registered_query: null,
    sequence,
    metrics: {},
    http_statuses: httpStatuses,
    protected_resource_proof: [],
    actor_proof: {},
    log_proof: {},
    latest_anomaly_diagnostics: {},
    nurse_caregiver: { implemented: false, mode: null, todo: 'Benchmark TODO: add nurse/caregiver latest-anomaly subscription/read when policy and client support are present.' },
    output_check: { passed: false, details: {} },
  };
  const pandaLogFile = path.join(rawDir, `panda-external-${benchmarkRunId}.log`);
  const replayerLogFile = path.join(rawDir, `replayer-${benchmarkRunId}.log`);
  let replayer;
  let querySession;
  try {
    const odrlLogFile = resolveReadableOdrlLogFile();
    if (!odrlLogFile) {
      throw new Error(
        [
          'Protected UMA/ODRL benchmark requires a live readable ODRL log file.',
          'Set PANDA_UMA_ODRL_LOG_FILE or UMA_ODRL_LOG_FILE, or start CSS/UMA with `npm run uma:start:odrl:logged`.',
        ].join(' ')
      );
    }
    const odrlLogInitialOffset = fs.statSync(odrlLogFile).size;
    const benchmarkOdrlLog = createBenchmarkOdrlLink(opts.benchmarkId, odrlLogFile);
    raw.log_proof = {
      log_files: [odrlLogFile],
      benchmark_log_file: benchmarkOdrlLog || null,
      initial_offset_bytes: odrlLogInitialOffset,
    };

    await waitForHttp('http://localhost:3000/', 10000);
    await waitForHttp('http://localhost:4000/uma', 10000);
    await waitForHttp(opts.pandaHttpUrl || 'http://localhost:8080/', 10000);
    sequence.preflight_services_reachable = isoNow();

    const preflightLog = path.join(rawDir, `user-managed-access-preflight-${benchmarkRunId}.log`);
    const umaEnv = {
      ...process.env,
      PANDA_UMA_ODRL_LOG_FILE: odrlLogFile,
      UMA_ODRL_LOG_FILE: odrlLogFile,
    };
    await execFileLogged('npm', ['run', 'verify:derived-alice'], { cwd: UMA_DIR, env: umaEnv }, preflightLog);
    await execFileLogged('npm', ['run', 'smoke:derived-anomaly-alert'], { cwd: UMA_DIR, env: umaEnv }, preflightLog);
    const liveProof = assertLiveOdrlProof(odrlLogFile, odrlLogInitialOffset, 'Protected benchmark preflight');
    const odrlLogRunStartOffset = fs.statSync(odrlLogFile).size;
    raw.log_proof = {
      ...raw.log_proof,
      preflight_start_offset_bytes: odrlLogInitialOffset,
      preflight_end_offset_bytes: liveProof.endOffset,
      run_start_offset_bytes: odrlLogRunStartOffset,
      ...liveProof.proof,
    };
    sequence.user_managed_access_derived_verified = isoNow();

    raw.protected_resource_proof = await assertProtectedTargets([
      'http://localhost:3000/alice/spo2/',
      'http://localhost:3000/alice/derived/',
      'http://localhost:3000/alice/derived/anomaly-alert/',
      'http://localhost:3000/alice/derived/latest-anomaly',
    ], httpStatuses);
    sequence.protected_resource_proof_complete = isoNow();

    const counters = { started: false, completed: false, posted: 0 };
    const effectiveOpts = {
      ...opts,
      replayerDuration: scenario.replayer_duration_seconds || opts.replayerDuration,
      queryWindow: scenario.query_window_seconds || opts.queryWindow,
      queryRegistrationDelay: scenario.query_registration_delay_after_replayer_start_seconds || 0,
    };
    querySession = createQueryRegistrationSession(scenario, effectiveOpts, benchmarkRunId, 'ack_only');
    const ackResult = await querySession.resultPromise;
    raw.registered_query = ackResult.registeredQuery || null;
    raw.query_template_source = {
      scenario_file_path: scenario.__scenario_file || null,
      scenario_id: scenario.scenario_id,
      query_template_before_substitution: scenario.panda_query_payload.query_template,
      query_string_after_substitution: raw.registered_query,
    };
    sequence.query_registered = ackResult.querySendWall || isoNow();
    sequence.query_register_ack = ackResult.ackWall || undefined;
    raw.actor_proof.panda_registered_query = true;

    replayer = await runReplayer(scenario, effectiveOpts, runRoot, benchmarkRunId, counters);
    sequence.replayer_started = replayer.startedAtWall;
    await waitForReplayerActive(counters, 30000);
    if (replayer.child.exitCode !== null) {
      throw new Error('Invalid run: replayer finished before RSP observation flow started');
    }
    const rspProofCandidates = [
      pandaLogFile,
      ...listCandidatePandaLogFiles(),
    ].filter(Boolean);
    const currentRunRspProof = await waitForCurrentRunRspProof(rspProofCandidates, benchmarkRunId, 180000);
    sequence.current_run_rsp_output_observed = currentRunRspProof.rsp_result_timestamp || currentRunRspProof.log_timestamp || isoNow();

    const replayerExitInfo = await replayer.exitInfoPromise;
    replayer.stopWatcher?.();
    sequence.replayer_completed = replayerExitInfo.exitedAtWall;
    raw.replayer_process = {
      command: replayer.command,
      requested_duration_seconds: effectiveOpts.replayerDuration,
      process_started_at: replayer.startedAtWall,
      process_exit_at: replayerExitInfo.exitedAtWall,
      exit_code: replayerExitInfo.code,
      exit_signal: replayerExitInfo.signal,
      actual_process_runtime_ms: replayerExitInfo.exitedAtPerf - replayer.startedAtPerf,
    };

    const pandaAlertProof = parsePandaAlertProof(pandaLogFile, benchmarkRunId);
    // If PANDA is externally managed, inspect the caller-provided monitor log first,
    // then common benchmark log locations. The benchmark never writes anomaly alerts.
    if (!pandaAlertProof.panda_wrote_anomaly_alert) {
      const candidates = listCandidatePandaLogFiles();
      for (const candidate of candidates) {
        const parsed = parsePandaAlertProof(candidate, benchmarkRunId);
        if (parsed.panda_wrote_anomaly_alert) Object.assign(pandaAlertProof, parsed);
      }
    }
    const replayerProof = parseReplayerProof(replayer.logFile);
    raw.actor_proof = {
      ...raw.actor_proof,
      replayer_wrote_spo2_observations: replayerProof.wrote_spo2,
      replayer_write_through_uma: replayerProof.uma_challenge_observed,
      current_run_rsp_output_observed: Boolean(currentRunRspProof),
      panda_wrote_anomaly_alerts: pandaAlertProof.panda_wrote_anomaly_alert,
      panda_alert_resource: pandaAlertProof.resource,
    };
    if (!replayerProof.wrote_spo2) throw new Error('Replayer did not write SpO2 observations.');
    if (!replayerProof.uma_challenge_observed) throw new Error('Replayer write did not observe UMA challenge.');
    if (!currentRunRspProof) throw new Error('Current-run RSP output was not observed.');

    const acceptedRspQueryHash = currentRunRspProof.rsp_query_hash || null;
    const acceptedRspWindowFrom = currentRunRspProof.rsp_window_start || null;
    const acceptedRspWindowTo = currentRunRspProof.rsp_window_end || null;
    raw.rsp_output_proof = {
      query_hash: acceptedRspQueryHash,
      aggregation_window_from: acceptedRspWindowFrom,
      aggregation_window_to: acceptedRspWindowTo,
      benchmark_run_id: currentRunRspProof.benchmark_run_id || null,
      accepted_result_validation_reason: 'panda_internal_rsp_proof',
      accepted_result_event_time_span_ms: acceptedRspWindowFrom && acceptedRspWindowTo
        ? Math.max(0, Date.parse(acceptedRspWindowTo) - Date.parse(acceptedRspWindowFrom))
        : null,
      accepted_result_rsp_window_metadata_source: 'panda_alert_rsp_proof',
      accepted_result_rsp_window_metadata_span_ms: acceptedRspWindowFrom && acceptedRspWindowTo
        ? Math.max(0, Date.parse(acceptedRspWindowTo) - Date.parse(acceptedRspWindowFrom))
        : null,
      message_sample: currentRunRspProof.line,
      rsp_result_timestamp: currentRunRspProof.rsp_result_timestamp || null,
    };

    let latest;
    try {
      latest = await pollLatestAnomalyForRun(
        'http://localhost:3000/alice/derived/latest-anomaly',
        benchmarkRunId,
        90000,
        acceptedRspQueryHash,
      );
    } catch (error) {
      raw.latest_anomaly_diagnostics = {
        alice_final_status_code: error?.details?.alice_final_status_code ?? null,
        alice_body_snippet: error?.details?.alice_body_snippet ?? null,
        alice_total_attempts: error?.details?.alice_total_attempts ?? null,
        alice_total_loop_duration_ms: error?.details?.alice_total_loop_duration_ms ?? null,
        alice_poll_function_start_iso: error?.details?.alice_poll_function_start_iso ?? null,
        alice_poll_function_start_ms: error?.details?.alice_poll_function_start_ms ?? null,
        alice_first_attempt_start_iso: error?.details?.alice_first_attempt_start_iso ?? null,
        alice_first_attempt_start_ms: error?.details?.alice_first_attempt_start_ms ?? null,
        alice_first_to_timeout_ms: error?.details?.alice_first_to_timeout_ms ?? null,
        alice_attempt_history: error?.details?.alice_attempt_history ?? [],
        rsp_proof_verified: error?.details?.rsp_proof_verified ?? false,
        anomaly_resource_written: pandaAlertProof.panda_wrote_anomaly_alert,
        anomaly_resource: pandaAlertProof.resource || null,
        odrl_proof_status: {
          run_start_offset_bytes: raw.log_proof.run_start_offset_bytes,
          odrl_authorizer: false,
          evaluating_request: false,
          false_decision: false,
          true_decision: false,
        },
      };
      const latestProof = odrlProofFromText(readOdrlLogDelta(odrlLogFile, raw.log_proof.run_start_offset_bytes).delta, odrlLogFile);
      raw.latest_anomaly_diagnostics.odrl_proof_status = {
        run_start_offset_bytes: raw.log_proof.run_start_offset_bytes,
        odrl_authorizer: latestProof.odrl_authorizer,
        evaluating_request: latestProof.evaluating_request,
        false_decision: latestProof.false_decision,
        true_decision: latestProof.true_decision,
      };
      throw error;
    }
    sequence.alice_latest_anomaly_read = isoNow();
    raw.actor_proof.alice_read_latest_anomaly = true;
    raw.latest_anomaly_sample = latest.body.slice(0, 2000);
    raw.latest_anomaly_diagnostics = {
      alice_final_status_code: latest.response.status,
      alice_body_snippet: latest.body.slice(0, 500),
      alice_total_attempts: latest.alice_total_attempts,
      alice_total_loop_duration_ms: latest.alice_total_loop_duration_ms,
      alice_poll_function_start_iso: latest.alice_poll_function_start_iso,
      alice_poll_function_start_ms: latest.alice_poll_function_start_ms,
      alice_first_attempt_start_iso: latest.alice_first_attempt_start_iso,
      alice_first_attempt_start_ms: latest.alice_first_attempt_start_ms,
      alice_first_attempt_to_success_ms: latest.alice_first_attempt_to_success_ms,
      alice_attempt_history: latest.alice_attempt_history,
      rsp_proof_verified: latest.rsp_proof_verified === true,
      anomaly_resource_written: pandaAlertProof.panda_wrote_anomaly_alert,
      anomaly_resource: pandaAlertProof.resource || null,
    };
    if (!raw.actor_proof.panda_wrote_anomaly_alerts && latest.body.includes(benchmarkRunId)) {
      raw.actor_proof.panda_wrote_anomaly_alerts = true;
      raw.actor_proof.panda_alert_resource = 'http://localhost:3000/alice/derived/anomaly-alert/ (inferred from latest-anomaly derived output containing the PANDA benchmark source event)';
    }
    if (!raw.actor_proof.panda_wrote_anomaly_alerts) throw new Error('PANDA did not write anomaly alert to /alice/derived/anomaly-alert/.');
    if (!String(raw.actor_proof.panda_alert_resource || '').includes('/alice/derived/anomaly-alert/')) {
      throw new Error(`PANDA alert write target was not /alice/derived/anomaly-alert/: ${raw.actor_proof.panda_alert_resource || 'unknown'}`);
    }

    const firstWriteMs = replayerProof.first_write_timestamp ? Date.parse(replayerProof.first_write_timestamp) : null;
    const latestReadMs = Date.parse(sequence.alice_latest_anomaly_read);
    const firstRspOutputMs = currentRunRspProof.rsp_result_timestamp ? Date.parse(currentRunRspProof.rsp_result_timestamp) : null;
    const pandaAlertSuccessMs = pandaAlertProof.success_ms;
    const alice_poll_function_start_ms = latest.alice_poll_function_start_ms;
    const alice_first_attempt_start_ms = latest.alice_first_attempt_start_ms;
    const alice_total_attempts = latest.alice_total_attempts;
    const alice_final_read_ms = latestReadMs;
    
    // Count attempt verdicts from history
    let alice_success_attempt_count = 0;
    let alice_stale_200_count = 0;
    let alice_404_count = 0;
    let alice_uma_error_count = 0;
    for (const attempt of (latest.alice_attempt_history || [])) {
      if (attempt.alice_freshness_verdict === 'fresh') {
        alice_success_attempt_count += 1;
      } else if (attempt.alice_final_status_code === 404 || attempt.alice_freshness_verdict === 'not_found') {
        alice_404_count += 1;
      } else if (attempt.alice_freshness_verdict === 'uma_error') {
        alice_uma_error_count += 1;
      } else if (attempt.alice_final_status_code === 200) {
        alice_stale_200_count += 1;
      }
    }
    
    raw.metrics = {
      ws_connect_ms: ackResult.wsConnectAt && ackResult.wsConnectStartAt ? ackResult.wsConnectAt - ackResult.wsConnectStartAt : null,
      query_registration_send_to_ack_ms: ackResult.ackAt && ackResult.querySendAt ? ackResult.ackAt - ackResult.querySendAt : null,
      query_registration_to_first_rsp_output_ms: firstRspOutputMs && ackResult.querySendWall ? firstRspOutputMs - Date.parse(ackResult.querySendWall) : null,
      replayer_first_observation_write_ms: replayerProof.first_write_ms,
      replayer_observation_write_to_panda_receive_ms: firstWriteMs && pandaAlertProof.receive_ms ? pandaAlertProof.receive_ms - firstWriteMs : null,
      panda_receive_to_anomaly_detected_ms: pandaAlertProof.receive_ms && pandaAlertProof.detected_ms ? pandaAlertProof.detected_ms - pandaAlertProof.receive_ms : null,
      anomaly_detected_to_panda_pod_write_start_ms: pandaAlertProof.detected_ms && pandaAlertProof.write_start_ms ? pandaAlertProof.write_start_ms - pandaAlertProof.detected_ms : null,
      rsp_output_to_panda_alert_write_start_ms: firstRspOutputMs && pandaAlertProof.write_start_ms ? pandaAlertProof.write_start_ms - firstRspOutputMs : null,
      rsp_output_to_panda_alert_write_success_ms: firstRspOutputMs && pandaAlertSuccessMs ? pandaAlertSuccessMs - firstRspOutputMs : null,
      panda_anomaly_pod_write_uma_challenge_ms: null,
      panda_anomaly_pod_write_token_exchange_ms: null,
      panda_anomaly_pod_write_authorized_request_ms: pandaAlertProof.request_ms && pandaAlertProof.response_ms ? pandaAlertProof.response_ms - pandaAlertProof.request_ms : null,
      panda_anomaly_pod_write_total_ms: pandaAlertProof.write_start_ms && pandaAlertProof.success_ms ? pandaAlertProof.success_ms - pandaAlertProof.write_start_ms : null,
      // NEW METRICS: Key diagnostic metrics for A vs B
      panda_alert_write_success_to_first_alice_attempt_start_ms: pandaAlertSuccessMs && alice_first_attempt_start_ms ? alice_first_attempt_start_ms - pandaAlertSuccessMs : null,
      first_alice_attempt_start_to_latest_success_ms: alice_first_attempt_start_ms && alice_final_read_ms ? alice_final_read_ms - alice_first_attempt_start_ms : null,
      latest_success_attempt_count: alice_success_attempt_count,
      latest_stale_200_count: alice_stale_200_count,
      latest_404_count: alice_404_count,
      latest_uma_error_count: alice_uma_error_count,
      // Legacy metrics (keeping for backward compatibility)
      panda_alert_write_success_to_alice_poll_function_start_ms: pandaAlertSuccessMs && alice_poll_function_start_ms ? alice_poll_function_start_ms - pandaAlertSuccessMs : null,
      panda_alert_write_success_to_alice_first_poll_attempt_ms: pandaAlertSuccessMs && alice_first_attempt_start_ms ? alice_first_attempt_start_ms - pandaAlertSuccessMs : null,
      alice_first_poll_attempt_to_latest_anomaly_success_ms: alice_first_attempt_start_ms && alice_final_read_ms ? alice_final_read_ms - alice_first_attempt_start_ms : null,
      alice_latest_read_poll_loop_duration_ms: alice_poll_function_start_ms && alice_final_read_ms ? alice_final_read_ms - alice_poll_function_start_ms : null,
      alice_latest_read_poll_function_start_ms: alice_poll_function_start_ms,
      alice_latest_read_first_attempt_ms: alice_first_attempt_start_ms,
      alice_latest_read_poll_attempt_count: alice_total_attempts,
      panda_alert_write_success_to_alice_latest_read_start_ms: pandaAlertSuccessMs && alice_poll_function_start_ms ? alice_poll_function_start_ms - pandaAlertSuccessMs : null,
      panda_alert_write_success_to_alice_latest_read_success_ms: pandaAlertSuccessMs ? Math.max(0, alice_final_read_ms - pandaAlertSuccessMs) : null,
      alice_latest_read_poll_duration_ms: alice_poll_function_start_ms && alice_final_read_ms ? alice_final_read_ms - alice_poll_function_start_ms : null,
      anomaly_written_to_latest_anomaly_available_ms: pandaAlertProof.success_ms ? Math.max(0, latestReadMs - pandaAlertProof.success_ms) : null,
      alice_latest_anomaly_uma_challenge_ms: latest.metrics.challenge_ms,
      alice_latest_anomaly_token_exchange_ms: latest.metrics.token_exchange_ms,
      alice_latest_anomaly_authorized_get_ms: latest.metrics.authorized_request_ms,
      alice_latest_anomaly_total_read_ms: latest.metrics.total_ms,
      nurse_latest_anomaly_notify_or_read_ms: null,
      end_to_end_replayer_to_rsp_output_ms: firstWriteMs && firstRspOutputMs ? firstRspOutputMs - firstWriteMs : null,
      rsp_output_to_alice_latest_anomaly_success_ms: firstRspOutputMs && latestReadMs ? latestReadMs - firstRspOutputMs : null,
      end_to_end_replayer_to_alice_latest_anomaly_ms: firstWriteMs ? latestReadMs - firstWriteMs : null,
      end_to_end_replayer_to_nurse_notification_ms: null,
      odrl_decision_latency_ms: null,
    };
    raw.alert_log_proof = pandaAlertProof.lines;
    raw.alert_rsp_proof = pandaAlertProof.rsp_proof;
    const runLiveProof = assertLiveOdrlProof(odrlLogFile, raw.log_proof.run_start_offset_bytes, 'Protected benchmark run');
    raw.log_proof = {
      ...raw.log_proof,
      run_end_offset_bytes: runLiveProof.endOffset,
      live_growth_bytes: Math.max(0, runLiveProof.endOffset - raw.log_proof.run_start_offset_bytes),
      odrl_authorizer: runLiveProof.proof.odrl_authorizer,
      evaluating_request: runLiveProof.proof.evaluating_request,
      matching_policy_rules: runLiveProof.proof.matching_policy_rules,
      odrl_decision: runLiveProof.proof.odrl_decision,
      false_decision: runLiveProof.proof.false_decision,
      true_decision: runLiveProof.proof.true_decision,
      replayer_spo2_write: runLiveProof.proof.replayer_spo2_write,
      panda_alert_write: runLiveProof.proof.panda_alert_write,
      alice_latest_read: runLiveProof.proof.alice_latest_read,
      proof_lines: runLiveProof.proof.proof_lines,
      validation_basis: 'live_log_growth_after_preflight',
    };
    raw.latest_anomaly_diagnostics.odrl_proof_status = {
      run_start_offset_bytes: raw.log_proof.run_start_offset_bytes,
      run_end_offset_bytes: raw.log_proof.run_end_offset_bytes,
      live_growth_bytes: raw.log_proof.live_growth_bytes,
      odrl_authorizer: raw.log_proof.odrl_authorizer,
      evaluating_request: raw.log_proof.evaluating_request,
      false_decision: raw.log_proof.false_decision,
      true_decision: raw.log_proof.true_decision,
    };
    raw.output_check = validateDerivedAnomalyOutput(raw);
    raw.status = 'complete';
    raw.completed_at = isoNow();
    
    // Compute latency classification based on evidence
    raw.latency_classification = classifyLatencyGap(raw.metrics, raw.latest_anomaly_diagnostics, pandaAlertSuccessMs);
    
    attachMetricDefinitions(raw);
    writeJson(rawPath, raw);
    if (!raw.output_check.passed) {
      writeJson(failurePath, raw);
      if (!opts.continueOnFailure) throw new Error('Derived anomaly benchmark output validation failed');
    }
    return raw;
  } catch (error) {
    raw.status = 'failed';
    raw.completed_at = isoNow();
    raw.error = error?.stack || String(error);
    if (raw.output_check?.details?.failures) {
      raw.output_check.details.error = String(error?.message || error);
    } else {
      raw.output_check = { passed: false, details: { error: String(error?.message || error) } };
    }
    attachMetricDefinitions(raw);
    writeJson(failurePath, raw);
    writeJson(rawPath, raw);
    if (!opts.continueOnFailure) throw error;
    return raw;
  } finally {
    replayer?.stopWatcher?.();
    stopChild(replayer?.child);
    querySession?.cancel?.();
  }
}

function validateDerivedAnomalyOutput(raw) {
  const failures = [];
  const m = raw.metrics || {};
  if (!raw.actor_proof?.replayer_wrote_spo2_observations) failures.push('Replayer did not write SpO2 observations.');
  if (!raw.actor_proof?.replayer_write_through_uma) failures.push('Replayer write did not observe UMA.');
  if (!raw.actor_proof?.panda_registered_query) failures.push('PANDA query registration was not observed.');
  if (!raw.actor_proof?.current_run_rsp_output_observed) failures.push('Current-run RSP output was not observed.');
  if (!raw.actor_proof?.panda_wrote_anomaly_alerts) failures.push('PANDA did not write anomaly alerts.');
  if (!raw.actor_proof?.alice_read_latest_anomaly) failures.push('Alice did not read latest-anomaly.');
  if (!raw.latest_anomaly_diagnostics?.challenge_observed) failures.push('Alice latest-anomaly read did not observe UMA challenge.');
  if (!raw.latest_anomaly_diagnostics?.rsp_proof_verified) failures.push('Alice latest-anomaly body did not prove current-run RSP-derived origin.');
  if (raw.latest_anomaly_diagnostics?.status_code !== 200) failures.push('Alice latest-anomaly read did not return HTTP 200.');
  if (!Number.isFinite(m.ws_connect_ms)) failures.push('WebSocket connect metric missing.');
  if (!Number.isFinite(m.query_registration_send_to_ack_ms)) failures.push('Query registration ack metric missing.');
  if (!Number.isFinite(m.query_registration_to_first_rsp_output_ms)) failures.push('Query registration to first RSP output metric missing.');
  if (!Number.isFinite(m.alice_latest_anomaly_total_read_ms)) failures.push('Alice latest-anomaly read metric missing.');
  if (!Number.isFinite(m.end_to_end_replayer_to_rsp_output_ms)) failures.push('End-to-end replayer to RSP output metric missing.');
  if (!Number.isFinite(m.end_to_end_replayer_to_alice_latest_anomaly_ms)) failures.push('End-to-end Alice metric missing.');
  if ((raw.protected_resource_proof || []).some((entry) => entry.status === 200)) failures.push('A protected resource was public.');
  if (!raw.latest_anomaly_sample || !raw.latest_anomaly_sample.includes(raw.benchmark_run_id)) failures.push('latest-anomaly did not contain current benchmark run id.');
  if (!/derivedFrom[^\n]*"rsp-query-result"/i.test(raw.latest_anomaly_sample || '')) failures.push('latest-anomaly did not contain the RSP-derived marker.');
  if (!/rspQueryHash/i.test(raw.latest_anomaly_sample || '')) failures.push('latest-anomaly did not contain rspQueryHash proof.');
  if (!/rspWindowStart/i.test(raw.latest_anomaly_sample || '') || !/rspWindowEnd/i.test(raw.latest_anomaly_sample || '')) failures.push('latest-anomaly did not contain RSP window proof.');
  const rspProof = raw.rsp_output_proof || {};
  if (rspProof.benchmark_run_id !== raw.benchmark_run_id) failures.push('Accepted RSP output benchmark run id did not match the current run.');
  if (!rspProof.query_hash) failures.push('Accepted RSP output did not expose a query hash.');
  const alertRspProof = raw.alert_rsp_proof || {};
  if (alertRspProof.derived_from !== 'rsp-query-result') failures.push('PANDA alert write log did not prove RSP-derived origin.');
  if (rspProof.query_hash && alertRspProof.rsp_query_hash !== rspProof.query_hash) failures.push('PANDA alert write log query hash did not match the accepted RSP output.');
  const logProof = raw.log_proof || {};
  for (const key of ['odrl_authorizer', 'evaluating_request', 'odrl_decision', 'false_decision', 'true_decision']) {
    if (!logProof[key]) failures.push(`Missing ODRL proof: ${key}`);
  }
  return {
    passed: failures.length === 0,
    details: failures.length === 0 ? { reason: 'protected derived anomaly flow verified' } : { failures },
  };
}

async function runOneScenario(scenario, opts, runRoot, runId, phase) {
  if (scenario.scenario_type === 'uma_replayer_panda_derived_anomaly_e2e') {
    return runDerivedAnomalyScenario(scenario, opts, runRoot, runId, phase);
  }
  const isWarmup = phase === 'warmup';
  const benchmarkRunId = `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : runId}-${randomUUID()}`;
  const rawDir = isWarmup ? path.join(runRoot, 'warmup') : path.join(runRoot, 'raw');
  const failureDir = isWarmup ? path.join(runRoot, 'failures', 'warmup') : path.join(runRoot, 'failures');
  ensureDir(rawDir);
  ensureDir(failureDir);
  const rawPath = path.join(rawDir, `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : `run-${runId}`}.json`);
  const failurePath = path.join(failureDir, `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : `run-${runId}`}.json`);
  const httpStatuses = [];
  const sequence = {};
  const startedAt = isoNow();
  const raw = {
    benchmark_id: opts.benchmarkId,
    benchmark_run_id: benchmarkRunId,
    git_commit: safeGitCommit(),
    node_version: process.version,
    scenario_id: scenario.scenario_id,
    scenario_file_path: scenario.__scenario_file || null,
    run_id: runId,
    phase,
    mode: opts.mode,
    deployment_mode: 'single_machine',
    query_window_seconds: opts.queryWindow,
    replayer_duration_seconds: opts.replayerDuration,
    query_registration_delay_seconds: opts.queryRegistrationDelay,
    started_at: startedAt,
    completed_at: null,
    status: 'running',
    registered_query: null,
    query_template_source: null,
    parsed_rspql_windows: null,
    rsp_window_parameter_unit: null,
    run_isolation: null,
    replayer_process: null,
    validation_warnings: [],
    sequence,
    metrics: {},
    http_statuses: httpStatuses,
    log_markers_found: [],
    output_check: { passed: false, details: {} },
  };
  let panda;
  let umaProcess;
  let replayer;
  const events = {};
  const markEvent = (event, notes = '') => {
    events[event] = { t: performance.now(), timestamp: isoNow(), notes };
  };
  let counters = { started: false, completed: false, posted: 0 };
  let queryRegisterPostedCount = 0;
  const runStartedAt = performance.now();
  let stopReplayerWatcher = () => {};
  try {
    killPortsIfForced(opts.force, [3000, 4000, 8080]);
    await sleep(opts.force ? 2000 : 0);
    markEvent('css_uma_start_start');
    const uma = await startUma(opts, runRoot, runId);
    umaProcess = uma.child;
    markEvent('css_uma_ready');
    sequence.css_uma_started = isoNow();
    raw.metrics.css_uma_startup_ms = uma.ms;
    const setup = await createContainersAndPolicies(scenario, uma.cssStatePath, httpStatuses);
    markEvent('containers_created');
    sequence.containers_created = isoNow();
    markEvent('meta_policies_written');
    sequence.meta_policies_written = isoNow();
    raw.metrics.container_creation_ms = setup.containerCreationMs;
    raw.metrics.meta_policy_write_ms = setup.metaPolicyWriteMs;

    markEvent('panda_start_start');
    const pandaPromise = startPanda(runRoot, runId);
    await sleep(15000);
    panda = await pandaPromise;
    markEvent('panda_ready');
    sequence.panda_started = isoNow();
    raw.metrics.panda_startup_ms = panda.ms;

    replayer = await runReplayer(scenario, opts, runRoot, benchmarkRunId, counters);
    stopReplayerWatcher = replayer.stopWatcher || (() => {});
    markEvent('replayer_start');
    sequence.replayer_started = isoNow();
    const replayerStartedAt = replayer.startedAtPerf;
    await waitForReplayerActive(counters, 30000);
    const delayRemaining = opts.queryRegistrationDelay * 1000 - (performance.now() - replayerStartedAt);
    if (delayRemaining > 0) await sleep(delayRemaining);
    if (replayer.child.exitCode !== null) {
      throw new Error('Invalid run: replayer finished before query registration');
    }
    queryRegisterPostedCount = counters.posted;
    const queryResult = await registerQueryAndWait(scenario, opts, benchmarkRunId);
    const serverQueryMetadata = extractServerQueryMetadata(queryResult);
    raw.registered_query = queryResult.registeredQuery || serverQueryMetadata.registeredQuery;
    raw.query_template_source = {
      scenario_file_path: scenario.__scenario_file || null,
      scenario_id: scenario.scenario_id,
      query_template_before_substitution: scenario.panda_query_payload.query_template,
      query_string_after_substitution: raw.registered_query,
    };
    raw.parsed_rspql_windows = serverQueryMetadata.parsedWindows;
    raw.rsp_window_parameter_unit = serverQueryMetadata.windowParameterUnit;
    sequence.query_registered = queryResult.querySendWall || isoNow();
    sequence.query_register_ack = queryResult.ackWall || undefined;
    sequence.client_result_received = isoNow();

    const timing = queryResult.message?.benchmark_timing || {};
    const serverRegistered = parseNs(timing.query_registered_at_ns);
    const serverFirstAdd = parseNs(timing.first_stream_event_added_at_ns || timing.first_stream_event_at_ns);
    const serverSent = parseNs(timing.server_sent_at_ns);
    const serverFirstResult = parseNs(timing.first_result_emitted_at_ns);
    const serverFirstWindowEvaluation = parseNs(timing.rsp_window_evaluated_at_ns);
    const metrics = timing.metrics || {};
    const queryToResultMs = queryResult.firstResultAt - queryResult.querySendAt;
    const queryToFirstAddMs = nsDiffMs(serverRegistered, serverFirstAdd);
    const serverRegisteredToServerSentMs = nsDiffMs(serverRegistered, serverSent);
    sequence.rsp_first_event_after_query_registered = timing.first_stream_event_added_at_ns ? isoNow() : undefined;
    sequence.first_any_result_emitted = timing.first_result_emitted_at_ns ? isoNow() : undefined;
    raw.metrics = {
      ...raw.metrics,
      query_registered_to_result_received_ms: queryToResultMs,
      rsp_first_post_registration_event_added_to_result_received_ms: Number.isFinite(queryToFirstAddMs) ? Math.max(0, queryToResultMs - queryToFirstAddMs) : null,
      window_adjusted_observed_latency_ms: queryToResultMs - opts.queryWindow * 1000,
      expected_window_wait_ms: opts.queryWindow * 1000,
      replayer_start_to_query_register_ms: queryResult.querySendAt - replayerStartedAt,
      replayer_total_runtime_ms: 0,
      replayer_events_posted_before_query_registration: queryRegisterPostedCount,
      replayer_events_posted_after_query_registration: Math.max(0, counters.posted - queryRegisterPostedCount),
      query_registration_ack_ms: queryResult.ackAt ? queryResult.ackAt - queryResult.querySendAt : null,
      rsp_first_event_after_query_registration_delay_ms: queryToFirstAddMs,
      rdf_parse_ms: metrics.rdf_parse_ms ?? null,
      rdf_quads_parsed_count: metrics.rdf_quads_parsed_count ?? 0,
      source_events_with_current_benchmark_run_id_count: metrics.source_events_with_current_benchmark_run_id_count ?? null,
      source_events_without_benchmark_run_id_count: metrics.source_events_without_benchmark_run_id_count ?? null,
      source_events_with_other_benchmark_run_id_count: metrics.source_events_with_other_benchmark_run_id_count ?? null,
      rsp_engine_construct_ms: metrics.rsp_engine_construct_ms ?? null,
      rsp_register_emitter_ms: metrics.rsp_register_emitter_ms ?? null,
      rsp_event_add_count_total: metrics.rsp_event_add_count_total ?? 0,
      rsp_events_added_with_current_benchmark_run_id_count: metrics.rsp_events_added_with_current_benchmark_run_id_count ?? null,
      rsp_events_added_without_benchmark_run_id_count: metrics.rsp_events_added_without_benchmark_run_id_count ?? null,
      rsp_events_added_with_other_benchmark_run_id_count: metrics.rsp_events_added_with_other_benchmark_run_id_count ?? null,
      rsp_event_add_count_after_query_registration: metrics.rsp_event_add_count_after_query_registration ?? 0,
      rsp_event_add_total_ms: metrics.rsp_event_add_total_ms ?? null,
      rsp_event_add_mean_ms: metrics.rsp_event_add_mean_ms ?? null,
      rsp_event_add_p95_ms: metrics.rsp_event_add_p95_ms ?? null,
      rsp_first_any_result_emit_ms: nsDiffMs(serverRegistered, serverFirstWindowEvaluation),
      rsp_query_eval_ms: null,
      rsp_first_any_result_emit_processing_ms: metrics.first_result_emit_ms ?? null,
      result_emit_to_client_receive_ms: Number.isFinite(serverRegisteredToServerSentMs) ? Math.max(0, queryToResultMs - serverRegisteredToServerSentMs) : null,
      result_count: queryResult.resultCount,
      result_size_bytes: queryResult.resultSizeBytes,
      early_result_count_ignored: queryResult.earlyResultCount,
      uma_initial_challenge_ms: timing.uma?.uma_challenge_ms ?? null,
      uma_token_exchange_ms: timing.uma?.uma_token_exchange_ms ?? null,
      authorized_retry_ms: timing.uma?.uma_protected_get_ms ?? null,
      odrl_policy_eval_ms: null,
    };
    if (serverFirstResult && serverSent) {
      raw.metrics.rsp_first_any_result_emit_processing_ms = raw.metrics.rsp_first_any_result_emit_processing_ms ?? nsDiffMs(serverFirstResult, serverSent);
    }
    raw.client_result_delivery = queryResult.clientResultDelivery;
    raw.early_result_ignored_reasons_summary = queryResult.earlyResultIgnoredReasonsSummary;
    raw.early_result_ignored_samples = opts.mode === 'smoke' ? queryResult.earlyResultIgnoredSamples : undefined;
    Object.assign(raw, acceptedResultDebugFields(queryResult.acceptedResultEvidence));
    Object.assign(raw, aggregationWindowDebugFields(queryResult.message, 'accepted_result'));
    Object.assign(raw, firstAnyResultDebugFields(queryResult.firstAnyResultEvidence));
    Object.assign(raw, ignoredResultDebugFields(queryResult.lastIgnoredPartialEvidence));
    raw.run_isolation = buildRunIsolationEvidence(raw.metrics);
    raw.critical_path_timeline = buildCriticalPathTimeline(events, queryResult, timing);
    attachMetricDefinitions(raw);
    const replayerExitInfo = await replayer.exitInfoPromise;
    stopReplayerWatcher();
    markEvent('replayer_completed');
    sequence.replayer_completed = isoNow();
    raw.replayer_process = {
      command: replayer.command,
      requested_duration_seconds: opts.replayerDuration,
      process_started_at: replayer.startedAtWall,
      process_exit_at: replayerExitInfo.exitedAtWall,
      exit_code: replayerExitInfo.code,
      exit_signal: replayerExitInfo.signal,
      actual_process_runtime_ms: replayerExitInfo.exitedAtPerf - replayer.startedAtPerf,
    };
    raw.metrics.replayer_total_runtime_ms = raw.replayer_process.actual_process_runtime_ms;
    raw.metrics.replayer_events_posted_after_query_registration = Math.max(0, counters.posted - queryRegisterPostedCount);
    raw.critical_path_timeline = buildCriticalPathTimeline(events, queryResult, timing);
    attachMetricDefinitions(raw);
    if (!fs.existsSync(replayer.logFile)) {
      throw new Error(`Missing replayer log file at run completion: ${replayer.logFile}`);
    }
    raw.log_markers_found = findLogMarkers(panda.logFile, scenario.required_log_markers);
    raw.status = 'complete';
    raw.completed_at = isoNow();
    raw.validation_warnings = buildValidationWarnings(raw);
    raw.output_check = validateOutput(raw, scenario, counters);
    writeJson(rawPath, raw);
    if (!raw.output_check.passed) {
      writeJson(failurePath, raw);
      if (!opts.continueOnFailure) throw new Error('Benchmark output validation failed');
    }
    return raw;
  } catch (error) {
    raw.status = 'failed';
    raw.completed_at = isoNow();
    raw.error = error?.stack || String(error);
    raw.metrics.replayer_total_runtime_ms = raw.metrics.replayer_total_runtime_ms || (performance.now() - (replayer?.startedAtPerf || runStartedAt));
    raw.validation_warnings = buildValidationWarnings(raw);
    attachMetricDefinitions(raw);
    raw.output_check = { passed: false, details: { error: String(error?.message || error) } };
    writeJson(failurePath, raw);
    writeJson(rawPath, raw);
    if (!opts.continueOnFailure) throw error;
    return raw;
  } finally {
    stopReplayerWatcher();
    stopChild(replayer?.child);
    stopChild(panda?.child);
    stopChild(umaProcess);
    if (opts.force) {
      killPortsIfForced(true, [3000, 4000, 8080]);
    }
  }
}

function findLogMarkers(logFile, markers) {
  let text = '';
  try {
    text = fs.readFileSync(logFile, 'utf8');
  } catch (_) {
    return [];
  }
  return markers.filter((marker) => text.includes(marker));
}

function extractServerQueryMetadata(queryResult) {
  const timing = queryResult?.ack?.benchmark_timing || queryResult?.message?.benchmark_timing || null;
  return {
    registeredQuery: timing?.registered_query || null,
    parsedWindows: Array.isArray(timing?.parsed_rspql_windows) ? timing.parsed_rspql_windows : null,
    windowParameterUnit: timing?.rsp_window_parameter_unit || null,
  };
}

function buildRunIsolationEvidence(metrics) {
  const currentRunAdded = metrics?.rsp_events_added_with_current_benchmark_run_id_count ?? null;
  const missingRunAdded = metrics?.rsp_events_added_without_benchmark_run_id_count ?? null;
  const otherRunAdded = metrics?.rsp_events_added_with_other_benchmark_run_id_count ?? null;
  const acceptedResultBuiltOnlyFromCurrentRunEvents = currentRunAdded !== null
    && currentRunAdded > 0
    && (missingRunAdded ?? 0) === 0
    && (otherRunAdded ?? 0) === 0;

  return {
    source_events_with_benchmark_run_id_count: metrics?.source_events_with_current_benchmark_run_id_count ?? null,
    source_events_without_benchmark_run_id_count: metrics?.source_events_without_benchmark_run_id_count ?? null,
    source_events_with_other_benchmark_run_id_count: metrics?.source_events_with_other_benchmark_run_id_count ?? null,
    rsp_events_added_with_benchmark_run_id_count: currentRunAdded,
    rsp_events_added_without_benchmark_run_id_count: missingRunAdded,
    rsp_events_added_with_other_benchmark_run_id_count: otherRunAdded,
    accepted_result_built_only_from_current_run_events: acceptedResultBuiltOnlyFromCurrentRunEvents,
  };
}

function buildValidationWarnings(raw) {
  const warnings = [];
  const runtimeDeltaMs = Number.isFinite(raw?.metrics?.replayer_total_runtime_ms)
    ? Math.abs(raw.metrics.replayer_total_runtime_ms - raw.replayer_duration_seconds * 1000)
    : null;
  if (runtimeDeltaMs !== null && runtimeDeltaMs > 10_000) {
    warnings.push({
      code: 'replayer_runtime_mismatch',
      message: 'replayer_total_runtime_ms differs from requested duration by more than 10 seconds.',
      requested_duration_ms: raw.replayer_duration_seconds * 1000,
      actual_runtime_ms: raw.metrics.replayer_total_runtime_ms,
    });
  }

  const firstWindow = Array.isArray(raw.parsed_rspql_windows) ? raw.parsed_rspql_windows[0] : null;
  if (firstWindow && firstWindow.width === firstWindow.slide && (raw.early_result_ignored_reasons_summary?.partial_window || 0) > 0) {
    warnings.push({
      code: 'early_partial_result_with_equal_range_step',
      message: 'Observed an early partial result even though RANGE equals STEP.',
      parsed_range: firstWindow.width,
      parsed_step: firstWindow.slide,
      first_any_result_event_time_span_ms: raw.rsp_first_any_result_event_time_span_ms ?? null,
    });
  }

  if (Number.isFinite(raw?.metrics?.rdf_quads_parsed_count) && raw.metrics.rdf_quads_parsed_count > 10_000) {
    warnings.push({
      code: 'rdf_quads_parsed_count_high',
      message: 'rdf_quads_parsed_count is much higher than the typical smoke-run baseline.',
      rdf_quads_parsed_count: raw.metrics.rdf_quads_parsed_count,
    });
  }

  if (!raw.registered_query) {
    warnings.push({
      code: 'registered_query_missing',
      message: 'registered_query is missing from the raw result.',
    });
  }

  if (!firstWindow) {
    warnings.push({
      code: 'parsed_range_step_missing',
      message: 'Parsed RANGE/STEP metadata is missing from the raw result.',
    });
  }

  return warnings;
}

function safeGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return 'unknown';
  }
}

function loadScenarios(opts) {
  return fs.readdirSync(SCENARIO_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      ...readJson(path.join(SCENARIO_DIR, file)),
      __scenario_file: path.join(SCENARIO_DIR, file),
    }))
    .filter((scenario) => opts.onlyScenario || scenario.run_all_default !== false)
    .filter((scenario) => !opts.onlyScenario || scenario.scenario_id === opts.onlyScenario);
}

function shouldSkipRun(rawPath, opts) {
  if (!fs.existsSync(rawPath)) return false;
  const raw = readJson(rawPath);
  if (opts.retryFailed) {
    return raw.status === 'complete' && raw.output_check?.passed === true;
  }
  if (!opts.resume || opts.force) return false;
  return raw.status === 'complete' && raw.output_check?.passed === true;
}

function printCriticalPathSummary(raw) {
  if (!raw || raw.phase === 'warmup') return;
  console.log(`critical_path_timeline scenario=${raw.scenario_id} run=${raw.run_id}`);
  const interesting = new Set([
    'query_register_start',
    'query_register_ack',
    'rsp_first_event_after_query_register_added',
    'rsp_first_any_result_emit_ms',
    'server_first_valid_result_sent',
    'client_first_valid_result_received',
  ]);
  for (const event of raw.critical_path_timeline || []) {
    if (interesting.has(event.event)) {
      console.log(`${event.event}: ${Math.round(event.t_relative_ms)} ms`);
    }
  }
  const definitions = raw.metric_definitions || {};
  const byType = (type) => Object.entries(definitions)
    .filter(([, definition]) => definition.type === type)
    .map(([name]) => name);
  const critical = Object.entries(definitions)
    .filter(([, definition]) => definition.critical_path)
    .map(([name]) => name);
  const overlapping = Object.entries(definitions)
    .filter(([, definition]) => /overlap/i.test(definition.notes || ''))
    .map(([name]) => name);
  console.log(`metrics.critical_path=${critical.join(', ') || 'none'}`);
  console.log(`metrics.overlapping=${overlapping.join(', ') || 'none'}`);
  console.log(`metrics.cumulative=${byType('cumulative').join(', ') || 'none'}`);
  console.log(`metrics.derived=${byType('derived').join(', ') || 'none'}`);
  console.log(`metrics.unavailable=${byType('unavailable').join(', ') || 'none'}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensureRepoExists(UMA_DIR, {
    label: 'user-managed-access',
    envVarName: 'UMA_REPO',
    cliFlagName: null,
  });
  const runRoot = path.join(RESULTS_ROOT, opts.benchmarkId);
  ensureDir(path.join(runRoot, 'raw'));
  ensureDir(path.join(runRoot, 'warmup'));
  ensureDir(path.join(runRoot, 'failures'));
  ensureDir(path.join(runRoot, 'failures', 'warmup'));
  ensureDir(path.join(runRoot, 'aggregated'));
  const scenarios = loadScenarios(opts);
  const manifest = {
    benchmark_id: opts.benchmarkId,
    created_at: isoNow(),
    mode: opts.mode,
    runs: opts.runs,
    warmup: opts.warmup,
    scenarios: scenarios.map((scenario) => scenario.scenario_id),
    runner_command: commandForDisplay('node', [path.relative(ROOT, __filename), ...process.argv.slice(2)]),
  };
  writeJson(path.join(runRoot, 'manifest.json'), manifest);
  const ledger = [];
  for (const scenario of scenarios) {
    for (let i = 1; i <= opts.runs; i += 1) {
      // Run warmup(s) for this measured run first. Warmups are stored separately and must not
      // interfere with measured run ids or counted runs.
      let warmupFailed = false;
      for (let w = 1; w <= opts.warmup; w += 1) {
        const warmupRawPath = path.join(runRoot, 'warmup', `${scenario.scenario_id}-warmup-${w}.json`);
        if (shouldSkipRun(warmupRawPath, opts)) continue;
        const warmupRow = await runOneScenario(scenario, opts, runRoot, w, 'warmup');
        printCriticalPathSummary(warmupRow);
        ledger.push({ scenario_id: scenario.scenario_id, run_id: `warmup-${w}`, status: warmupRow.status, output_check: warmupRow.output_check });
        writeJson(path.join(runRoot, 'ledger.json'), ledger);
        if (warmupRow.status !== 'complete' || warmupRow.output_check?.passed !== true) {
          warmupFailed = true;
          console.error(`Warmup failed for scenario=${scenario.scenario_id} warmup=${w}; aborting measured run ${i}`);
          break;
        }
      }

      const rawPath = path.join(runRoot, 'raw', `${scenario.scenario_id}-run-${i}.json`);
      if (warmupFailed) {
        // Abort the measured run due to warmup failure and record a clear diagnostic.
        const failure = {
          benchmark_id: opts.benchmarkId,
          scenario_id: scenario.scenario_id,
          run_id: i,
          phase: 'measured',
          mode: opts.mode,
          started_at: isoNow(),
          completed_at: isoNow(),
          status: 'failed',
          error: `Aborted measured run ${i} because warmup for scenario ${scenario.scenario_id} failed. See warmup artifacts in ${path.join(runRoot, 'warmup')}`,
          output_check: { passed: false, details: { reason: 'warmup_failed' } },
        };
        writeJson(rawPath, failure);
        writeJson(path.join(runRoot, 'failures', `${scenario.scenario_id}-run-${i}.json`), failure);
        ledger.push({ scenario_id: scenario.scenario_id, run_id: i, status: failure.status, output_check: failure.output_check });
        writeJson(path.join(runRoot, 'ledger.json'), ledger);
        if (!opts.continueOnFailure) throw new Error(`Measured run ${i} aborted due to warmup failure`);
        continue;
      }

      if (shouldSkipRun(rawPath, opts)) continue;
      const row = await runOneScenario(scenario, opts, runRoot, i, 'measured');
      printCriticalPathSummary(row);
      ledger.push({ scenario_id: scenario.scenario_id, run_id: i, status: row.status, output_check: row.output_check });
      writeJson(path.join(runRoot, 'ledger.json'), ledger);
    }
  }
  console.log(`benchmark_id=${opts.benchmarkId}`);
  console.log(`results_dir=${runRoot}`);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
