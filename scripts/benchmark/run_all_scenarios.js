#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const { client: WebSocketClient } = require('websocket');
const {
  repoRoot,
  siblingDefaults,
  resolveRepoPath,
  ensureRepoExists,
} = require('./workspace_paths');
const {
  parseAuthenticateHeader: parseProtectedAuthenticateHeader,
  extractNotificationChannel,
  subscribeToWebhookChannel,
  startWebhookObserver,
  fetchUmaChallenge,
  exchangeToken: exchangeProtectedToken,
  authorizedGet,
  parseProtectedResultTurtle,
  checkOdrlLogProof,
} = require('./protected_result_helpers');

const ROOT = repoRoot;
const SCENARIO_DIR = path.join(ROOT, 'benchmarks', 'scenarios');
const RESULTS_ROOT = path.join(ROOT, 'benchmarks', 'results', 'runs');
const UMA_DIR = resolveRepoPath({
  cliValue: null,
  envVarName: 'UMA_REPO',
  defaultPath: siblingDefaults.umaRepo,
});
const WS_PROTOCOL = 'solid-stream-aggregator-protocol';
const PROC_STAT = '/proc/stat';
const DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS = 500;
const PAGE_SIZE_BYTES = 4096;

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
    collectResourceUsage: false,
    resourceSampleIntervalMs: DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS,
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
    if (key === '--collect-resource-usage') out.collectResourceUsage = true;
    if (key === '--resource-sample-interval-ms') out.resourceSampleIntervalMs = Number(next);
  }
  if (!out.benchmarkId) {
    out.benchmarkId = `panda-live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  if (!Number.isFinite(out.resourceSampleIntervalMs) || out.resourceSampleIntervalMs < 100) {
    out.resourceSampleIntervalMs = DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS;
  }
  return out;
}

function readCpuTotalJiffies() {
  const text = fs.readFileSync(PROC_STAT, 'utf8');
  const first = text.split('\n')[0] || '';
  const parts = first.trim().split(/\s+/);
  if (parts[0] !== 'cpu') return null;
  const total = parts.slice(1).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return Number.isFinite(total) ? total : null;
}

function readProcStat(pid) {
  const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const closeParen = statText.lastIndexOf(')');
  if (closeParen < 0) return null;
  const rest = statText.slice(closeParen + 2).trim().split(/\s+/);
  const utimeJiffies = Number(rest[11]);
  const stimeJiffies = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(utimeJiffies) || !Number.isFinite(stimeJiffies) || !Number.isFinite(rssPages)) {
    return null;
  }
  return {
    procJiffies: utimeJiffies + stimeJiffies,
    rssBytes: Math.max(0, rssPages) * PAGE_SIZE_BYTES,
  };
}

function discoverPidOnPort(port) {
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).trim();
    const pids = output ? output.split(/\s+/).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 1) : [];
    return pids[0] || null;
  } catch (_) {
    return null;
  }
}

// Check if a PID is live by verifying /proc/<pid> exists
function isPidLive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    fs.statSync(`/proc/${pid}`);
    return true;
  } catch (_) {
    return false;
  }
}

function createResourceSampler(config) {
  const {
    outFile,
    intervalMs,
    scenarioId,
    runId,
    benchmarkId,
    phase,
    trackedProcesses,
    samplesPath,
  } = config;
  ensureDir(path.dirname(outFile));
  const stream = fs.createWriteStream(outFile, { flags: 'a' });
  const startedAtPerf = performance.now();
  let timer = null;
  let stopped = false;
  let previousCpuTotalJiffies = null;
  const previousProcJiffiesByPid = new Map();
  // Track which PIDs have already emitted process_exit to avoid repeated emissions
  const exitedPids = new Set();

  const writeRow = (row) => {
    try {
      stream.write(`${JSON.stringify(row)}\n`);
    } catch (_) {
      // keep benchmark running if sample write fails
    }
  };

  const sample = () => {
    const timestampMs = Math.round(performance.now() - startedAtPerf);
    let cpuTotalJiffies = null;
    try {
      cpuTotalJiffies = readCpuTotalJiffies();
    } catch (_) {
      cpuTotalJiffies = null;
    }
    for (const target of trackedProcesses) {
      const base = {
        timestamp_ms: timestampMs,
        scenario_id: scenarioId,
        run_id: runId,
        phase,
        label: target.label,
        pid: Number.isFinite(target.pid) ? target.pid : null,
      };
      if (!Number.isFinite(target.pid)) {
        // PID was never captured at sampler start; emit missing_pid only on first sample
        if (timestampMs === 0) {
          writeRow({ ...base, event: 'missing_pid' });
        }
        continue;
      }
      try {
        const stat = readProcStat(target.pid);
        if (!stat) {
          // Process no longer available; emit process_exit only once
          if (!exitedPids.has(target.pid)) {
            exitedPids.add(target.pid);
            writeRow({ ...base, event: 'process_exit' });
          }
          continue;
        }
        let cpuPercent = null;
        const previousProc = previousProcJiffiesByPid.get(target.pid);
        if (
          Number.isFinite(cpuTotalJiffies)
          && Number.isFinite(previousCpuTotalJiffies)
          && Number.isFinite(previousProc)
        ) {
          const procDelta = stat.procJiffies - previousProc;
          const totalDelta = cpuTotalJiffies - previousCpuTotalJiffies;
          // Approximate process CPU% from Linux jiffy deltas:
          // cpu_percent ≈ (process_delta_jiffies / system_total_delta_jiffies) * 100 * cpu_core_count
          // This reports "one full core" as ~100%, and can exceed 100% on multi-core parallel work.
          if (procDelta >= 0 && totalDelta > 0) {
            const cores = os.cpus().length || 1;
            cpuPercent = (procDelta / totalDelta) * 100 * cores;
          }
        }
        previousProcJiffiesByPid.set(target.pid, stat.procJiffies);
        writeRow({
          ...base,
          event: 'sample',
          rss_bytes: stat.rssBytes,
          heap_used_bytes: null,
          heap_total_bytes: null,
          cpu_percent: Number.isFinite(cpuPercent) ? cpuPercent : null,
        });
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          // Process exited; emit only once
          if (!exitedPids.has(target.pid)) {
            exitedPids.add(target.pid);
            writeRow({ ...base, event: 'process_exit' });
          }
        } else {
          writeRow({ ...base, event: 'sample_error', error: String(error?.message || error) });
        }
      }
    }
    if (Number.isFinite(cpuTotalJiffies)) {
      previousCpuTotalJiffies = cpuTotalJiffies;
    }
  };

  return {
    start() {
      if (stopped) return;
      
      // Verify PIDs are live at startup
      let liveCount = 0;
      const initialStatus = trackedProcesses.map((target) => {
        const isLive = Number.isFinite(target.pid) && isPidLive(target.pid);
        if (isLive) liveCount += 1;
        return {
          label: target.label,
          pid: target.pid,
          is_live_at_start: isLive,
        };
      });
      
      // Warn if all tracked PIDs are missing/exited at sampler start
      if (liveCount === 0) {
        console.warn('[resource] WARNING: Resource collection started with no live tracked processes.');
      }
      
      writeRow({
        timestamp_ms: 0,
        event: 'resource_collection_started',
        benchmark_id: benchmarkId,
        scenario_id: scenarioId,
        run_id: runId,
        phase,
        sample_interval_ms: intervalMs,
        tracked_processes: initialStatus,
        samples_path: samplesPath,
      });
      sample();
      timer = setInterval(sample, intervalMs);
    },
    stop(reason = 'scenario_end') {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      writeRow({
        timestamp_ms: Math.round(performance.now() - startedAtPerf),
        event: 'resource_collection_stopped',
        reason,
      });
      stream.end();
    },
  };
}

function buildTrackedProcesses({ pandaPid, replayerPid }) {
  const cssPid = discoverPidOnPort(3000);
  const umaPid = discoverPidOnPort(4000);
  return [
    { label: 'panda_server', pid: Number.isFinite(pandaPid) ? pandaPid : null },
    { label: 'css_solid_server', pid: Number.isFinite(cssPid) ? cssPid : null },
    { label: 'uma_authorization_server', pid: Number.isFinite(umaPid) ? umaPid : null },
    { label: 'stream_replayer', pid: Number.isFinite(replayerPid) ? replayerPid : null },
  ];
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

function safeReadText(file) {
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
}

function renderUrlTemplate(template, benchmarkRunId) {
  return String(template || '').replace(/\{benchmark_run_id\}/g, benchmarkRunId);
}

function getProtectedResultConfig(scenario, benchmarkRunId) {
  if (scenario?.benchmark_mode !== 'protected_rsp_result' || !scenario?.protected_result) {
    return null;
  }
  return {
    ...scenario.protected_result,
    resource_url: renderUrlTemplate(scenario.protected_result.resource_url_template, benchmarkRunId),
  };
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

async function createContainersAndPolicies(scenario, cssStatePath, httpStatuses, benchmarkRunId) {
  const startedContainersAt = performance.now();
  const protectedResult = getProtectedResultConfig(scenario, benchmarkRunId);
  const dirs = [
    '',
    'alice',
    'alice/spo2',
    'alice/derived',
    'alice/derived/anomaly-alert',
  ];
  if (protectedResult) {
    dirs.push('alice/protected-rsp-results');
  }
  for (const dir of dirs) {
    ensureDir(path.join(cssStatePath, dir));
  }
  const containerUrls = [
    'http://localhost:3000/alice/spo2/',
    'http://localhost:3000/alice/derived/',
    'http://localhost:3000/alice/derived/anomaly-alert/',
  ];
  if (protectedResult) {
    containerUrls.push(protectedResult.container_url);
  }
  const policy = makeOdrlPolicy(scenario, benchmarkRunId);
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
  if (protectedResult) {
    metaFiles.set('alice/protected-rsp-results/.meta', '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n');
  }
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
  let protectedResultBootstrap = null;
  if (protectedResult) {
    const placeholderBody = `@prefix bench: <http://example.org/panda-benchmark#> .\n<> bench:status "placeholder" .\n`;
    const response = await fetchWithUma(protectedResult.resource_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: placeholderBody,
    });
    httpStatuses.push({ phase: 'protected_result_placeholder_put', status: response.status, url: protectedResult.resource_url });
    protectedResultBootstrap = {
      container_url: protectedResult.container_url,
      resource_url: protectedResult.resource_url,
      placeholder_status: response.status,
    };
  }
  return {
    containerCreationMs,
    metaPolicyWriteMs: performance.now() - startedMetaAt,
    metaPaths: Array.from(metaFiles.keys()),
    protectedResultBootstrap,
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

function makeOdrlPolicy(scenario, benchmarkRunId) {
  const stream = scenario.target_css_resources.stream_container_url;
  const latest = scenario.target_css_resources.derived_latest_url;
  const alert = scenario.target_css_resources.alert_container_url;
  const derived = 'http://localhost:3000/alice/derived/';
  const protectedResult = getProtectedResultConfig(scenario, benchmarkRunId);
  const metaTargets = [
    'http://localhost:3000/alice/.meta',
    'http://localhost:3000/alice/spo2/.meta',
    'http://localhost:3000/alice/derived/.meta',
    'http://localhost:3000/alice/derived/anomaly-alert/.meta',
  ];
  if (protectedResult) {
    metaTargets.push('http://localhost:3000/alice/protected-rsp-results/.meta');
  }
  const owner = 'http://localhost:3000/alice/profile/card#me';
  const nurse = protectedResult?.nurse_webid || 'http://localhost:3000/bob/profile/card#me';
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
  odrl:permission ex:readLatest, ex:readStream, ex:writeStream, ex:writeDerived, ex:writeAlert${protectedResult ? ', ex:writeProtectedResultContainer, ex:writeProtectedResultResource, ex:readProtectedResultResource' : ''}${metaTargets.map((_, index) => `, ex:writeMeta${index}`).join('')} .

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
${protectedResult ? `
ex:writeProtectedResultContainer a odrl:Permission ;
  odrl:target <${protectedResult.container_url}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action odrl:create, odrl:append, odrl:write, odrl:read .

ex:writeProtectedResultResource a odrl:Permission ;
  odrl:target <${protectedResult.resource_url}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action odrl:create, odrl:append, odrl:write, odrl:read .

ex:readProtectedResultResource a odrl:Permission ;
  odrl:target <${protectedResult.resource_url}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${nurse}> ;
  odrl:action odrl:read .
` : ''}
`.trim();
}

async function startPanda(runRoot, runId, scenario, benchmarkRunId) {
  const logFile = path.join(runRoot, 'raw', `panda-run-${runId}.log`);
  const startedAt = performance.now();
  const protectedResult = getProtectedResultConfig(scenario, benchmarkRunId);
  const child = spawnLogged('npm', ['run', 'start-monitoring'], {
    cwd: ROOT,
    env: {
      ...process.env,
      BENCHMARK_TIMING: '1',
      PANDA_EXPECTED_PROPERTY_IRI: 'https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2',
      ...(protectedResult ? {
        PANDA_BENCHMARK_PROTECTED_RESULT_URL: protectedResult.resource_url,
        PANDA_BENCHMARK_SCENARIO_ID: scenario.scenario_id,
      } : {}),
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

async function setupProtectedResultSubscription(protectedResultConfig) {
  const observer = await startWebhookObserver(protectedResultConfig.resource_url);
  const discovery = await extractNotificationChannel(protectedResultConfig.resource_url);
  const subscription = await subscribeToWebhookChannel(
    discovery.channelUrl,
    protectedResultConfig.resource_url,
    observer.sendTo,
    protectedResultConfig.owner_webid,
  );
  return {
    observer,
    discovery,
    subscription,
  };
}

async function performProtectedResultUmaRead(protectedResultConfig, umaLogFile) {
  const odrlLogBefore = safeReadText(umaLogFile);
  const challenge = await fetchUmaChallenge(protectedResultConfig.resource_url);
  const challengeParsed = challenge.status === 401
    ? parseProtectedAuthenticateHeader(challenge.header)
    : null;
  const token = challengeParsed
    ? await exchangeProtectedToken(challengeParsed.tokenEndpoint, challengeParsed.ticket, protectedResultConfig.nurse_webid)
    : null;
  const authorized = token?.json?.access_token
    ? await authorizedGet(
      protectedResultConfig.resource_url,
      token.json.token_type || 'Bearer',
      token.json.access_token,
    )
    : null;
  const odrlLogAfter = safeReadText(umaLogFile);
  const odrlProof = checkOdrlLogProof(
    odrlLogAfter.slice(odrlLogBefore.length),
    protectedResultConfig.resource_url,
    protectedResultConfig.nurse_webid,
  );
  const parsedBody = authorized?.status === 200
    ? parseProtectedResultTurtle(authorized.body)
    : null;
  return {
    challenge,
    token,
    authorized,
    odrlProof,
    parsedBody,
  };
}

function registerQueryAndWait(scenario, opts, benchmarkRunId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketClient();
    const timeout = setTimeout(() => {
      try { ws.abort(); } catch (_) {}
      reject(new Error('Timed out waiting for first benchmark result'));
    }, Math.max(180000, (opts.replayerDuration + 60) * 1000));
    const result = {
      querySendAt: 0,
      querySendWall: null,
      registeredQuery: null,
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
    ws.on('connectFailed', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.on('connect', (conn) => {
      conn.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
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
        if (!evidence.provesFullWindow) {
          recordIgnoredResult('partial_window', parsed, now, evidence);
          return;
        }
        if (!result.message) {
          result.resultCount += 1;
          result.firstResultAt = now;
          result.firstResultWall = isoNow();
          result.message = parsed;
          result.acceptedResultEvidence = evidence;
          result.resultSizeBytes = Buffer.byteLength(message.utf8Data);
          clearTimeout(timeout);
          try { conn.close(); } catch (_) {}
          resolve(result);
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
    ws.connect('ws://localhost:8080/', WS_PROTOCOL);
  });
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
    nurse_notification_subscribe_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'nurse_notification_subscribe_start',
      end_event: 'nurse_notification_subscribed',
      interpretation: 'Benchmark-runner time to discover the notification channel, create the webhook subscription, and confirm registration before the protected result is expected.',
      critical_path: false,
      notes: 'Setup before the protected critical path begins.',
    },
    rsp_output_to_panda_result_write_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'rsp_first_any_result_emit_ms',
      end_event: 'panda_protected_result_written',
      interpretation: 'Time from the accepted full-window RSP output becoming eligible for materialization until PANDA completed the protected Solid write.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    panda_result_write_total_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'protected_result_write_start',
      end_event: 'panda_protected_result_written',
      interpretation: 'Time spent on the protected result resource write itself.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    panda_result_write_to_notification_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'panda_protected_result_written',
      end_event: 'nurse_notification_received',
      interpretation: 'Notification delivery latency after PANDA completed the protected Solid write.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    nurse_notification_to_uma_get_start_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'nurse_notification_received',
      end_event: 'nurse_result_uma_get_start',
      interpretation: 'Runner-side delay between observing the notification and starting the nurse UMA GET flow.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    nurse_result_uma_challenge_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'nurse_result_uma_get_start',
      end_event: 'nurse_result_uma_challenge_complete',
      interpretation: 'Tokenless nurse GET latency until the UMA challenge was received.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    nurse_result_token_exchange_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'nurse_result_token_exchange_start',
      end_event: 'nurse_result_token_exchange_complete',
      interpretation: 'UMA ticket exchange latency for the nurse/caregiver protected result read.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    nurse_result_authorized_get_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'nurse_result_authorized_get_start',
      end_event: 'nurse_result_uma_get_complete',
      interpretation: 'Latency of the authorized nurse GET that returned the protected result body.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    nurse_result_total_read_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'nurse_result_uma_get_start',
      end_event: 'nurse_result_uma_get_complete',
      interpretation: 'End-to-end nurse read latency including challenge, ticket exchange, and authorized GET.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    end_to_end_replayer_to_rsp_output_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'replayer_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Time from the replayer start until the accepted full-window RSP result was observed over WebSocket.',
      critical_path: true,
      notes: 'This preserves the baseline live-window leg inside the protected scenario.',
    },
    end_to_end_replayer_to_nurse_result_read_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'replayer_start',
      end_event: 'nurse_result_uma_get_complete',
      interpretation: 'Full protected critical path: replayer start to nurse/caregiver authorized GET completion.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
    query_registration_to_nurse_result_read_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'query_register_start',
      end_event: 'nurse_result_uma_get_complete',
      interpretation: 'Time from query registration send until the nurse/caregiver authorized GET completed.',
      critical_path: true,
      notes: 'Protected scenario only.',
    },
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
    ['protected_result_write_start', parseNs(timing.protected_result_write_started_at_ns), 'PANDA started writing the protected Solid result resource.'],
    ['panda_protected_result_written', parseNs(timing.protected_result_write_completed_at_ns), 'PANDA finished writing the protected Solid result resource for the accepted full-window result.'],
    ['server_first_valid_result_sent', parseNs(timing.server_sent_at_ns), 'PANDA WebSocket relay sent the accepted result to the benchmark client.'],
  ];
  for (const [event, ns, notes] of serverEvents) {
    const rel = nsDiffMs(serverRegistered, ns);
    add(event, rel, addMsToIso(queryResult.querySendWall, rel), `${notes} Relative time is computed from PANDA server query_registered_at_ns.`);
  }

  if (queryResult.firstResultAt && queryResult.firstResultWall) {
    add('client_first_valid_result_received', queryResult.firstResultAt - queryResult.querySendAt, queryResult.firstResultWall, 'Benchmark client accepted the first result whose event-time span or explicit RSP window metadata proves a complete configured window.');
  }
  addLocal('nurse_notification_subscribed', 'Benchmark runner registered a Solid notification webhook before the protected result was expected.');
  addLocal('nurse_notification_received', 'Benchmark runner observed the Solid notification for the protected result resource.');
  addLocal('nurse_result_uma_get_start', 'Nurse/caregiver started the UMA-protected GET after notification.');
  addLocal('nurse_result_uma_get_complete', 'Nurse/caregiver completed the authorized GET of the protected result resource.');
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
  const isProtectedScenario = scenario?.benchmark_mode === 'protected_rsp_result';
  const protectedFlow = raw.protected_result_flow || {};
  const protectedBody = protectedFlow.returned_body_parsed || {};
  const protectedFlowPassed = !isProtectedScenario || Boolean(
    raw.sequence.nurse_notification_subscribed
    && raw.sequence.nurse_notification_received
    && raw.sequence.nurse_result_read_completed
    && protectedFlow.public_preflight_status !== 200
    && protectedFlow.notification_subscription_status === 'subscribed'
    && protectedFlow.notification_received?.matchesExpected === true
    && protectedFlow.nurse_get_status === 200
    && protectedBody.benchmarkRunId === raw.benchmark_run_id
    && protectedBody.derivedFrom === 'rsp-query-result'
    && protectedBody.rspQueryHash === queryResultHash(raw)
    && protectedFlow.odrl_proof?.passed === true
    && protectedFlow.stale_content_detected !== true
  );
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
    && protectedFlowPassed
  );
  if (!passed) {
    details.reason = 'One or more live benchmark validity checks failed.';
    if (missingLogMarkers.length > 0) details.missing_log_markers = missingLogMarkers;
    if (!acceptedFullWindow) details.accepted_result_validation_reason = raw.accepted_result_validation_reason || null;
    if (isProtectedScenario && !protectedFlowPassed) {
      details.protected_result_flow = {
        public_preflight_status: protectedFlow.public_preflight_status ?? null,
        notification_subscription_status: protectedFlow.notification_subscription_status ?? null,
        notification_received: protectedFlow.notification_received ?? null,
        nurse_get_status: protectedFlow.nurse_get_status ?? null,
        returned_body_parsed: protectedBody,
        odrl_proof: protectedFlow.odrl_proof ?? null,
        stale_content_detected: protectedFlow.stale_content_detected ?? null,
      };
    }
  }
  return { passed, details };
}

function queryResultHash(raw) {
  return raw?.message_query_hash || raw?.protected_result_flow?.websocket_protected_result?.rsp_query_hash || raw?.protected_result_flow?.websocket_protected_result?.rspQueryHash || null;
}

async function runOneScenario(scenario, opts, runRoot, runId, phase) {
  const isWarmup = phase === 'warmup';
  const benchmarkRunId = `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : runId}-${randomUUID()}`;
  const protectedResultConfig = getProtectedResultConfig(scenario, benchmarkRunId);
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
    benchmark_mode: scenario.benchmark_mode || 'baseline_websocket_result',
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
    resource_usage: null,
    validation_warnings: [],
    sequence,
    metrics: {},
    http_statuses: httpStatuses,
    log_markers_found: [],
    output_check: { passed: false, details: {} },
    protected_result_flow: null,
  };
  let panda;
  let umaProcess;
  let replayer;
  let protectedObserver;
  const events = {};
  const markEvent = (event, notes = '') => {
    events[event] = { t: performance.now(), timestamp: isoNow(), notes };
  };
  let counters = { started: false, completed: false, posted: 0 };
  let queryRegisterPostedCount = 0;
  const runStartedAt = performance.now();
  let stopReplayerWatcher = () => {};
  let resourceSampler = null;
  const sampleDir = isWarmup ? path.join(runRoot, 'warmup', 'resource-samples') : path.join(runRoot, 'raw', 'resource-samples');
  const resourceSampleFile = path.join(sampleDir, `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : `run-${runId}`}.jsonl`);
  try {
    killPortsIfForced(opts.force, [3000, 4000, 8080]);
    await sleep(opts.force ? 2000 : 0);
    markEvent('css_uma_start_start');
    const uma = await startUma(opts, runRoot, runId);
    umaProcess = uma.child;
    markEvent('css_uma_ready');
    sequence.css_uma_started = isoNow();
    raw.metrics.css_uma_startup_ms = uma.ms;
    const setup = await createContainersAndPolicies(scenario, uma.cssStatePath, httpStatuses, benchmarkRunId);
    markEvent('containers_created');
    sequence.containers_created = isoNow();
    markEvent('meta_policies_written');
    sequence.meta_policies_written = isoNow();
    raw.metrics.container_creation_ms = setup.containerCreationMs;
    raw.metrics.meta_policy_write_ms = setup.metaPolicyWriteMs;
    if (protectedResultConfig) {
      raw.protected_result_flow = {
        enabled: true,
        protected_result_url: protectedResultConfig.resource_url,
        protected_result_container_url: protectedResultConfig.container_url,
        bootstrap: setup.protectedResultBootstrap,
        notification_subscription_status: 'not_started',
      };
      const publicPreflight = await fetchUmaChallenge(protectedResultConfig.resource_url);
      raw.protected_result_flow.public_preflight_status = publicPreflight.status;
      raw.protected_result_flow.public_preflight_header = publicPreflight.header;
      markEvent('nurse_notification_subscribe_start');
      const subscriptionStartedAt = performance.now();
      const subscriptionSetup = await setupProtectedResultSubscription(protectedResultConfig);
      protectedObserver = subscriptionSetup.observer;
      raw.protected_result_flow.notification_channel = subscriptionSetup.discovery;
      raw.protected_result_flow.notification_subscription = subscriptionSetup.subscription;
      raw.protected_result_flow.notification_subscription_status = subscriptionSetup.subscription.ok ? 'subscribed' : 'subscription_failed';
      raw.metrics.nurse_notification_subscribe_ms = performance.now() - subscriptionStartedAt;
      markEvent('nurse_notification_subscribed');
      sequence.nurse_notification_subscribed = isoNow();
    }

    markEvent('panda_start_start');
    const pandaPromise = startPanda(runRoot, runId, scenario, benchmarkRunId);
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
    if (opts.collectResourceUsage) {
      const trackedProcesses = buildTrackedProcesses({
        pandaPid: panda?.child?.pid,
        replayerPid: replayer?.child?.pid,
      });
      const samplesPath = path.relative(ROOT, resourceSampleFile);
      raw.resource_usage = {
        enabled: true,
        sample_interval_ms: opts.resourceSampleIntervalMs,
        samples_path: samplesPath,
        tracked_processes: trackedProcesses,
      };
      console.log(`[resource] start scenario=${scenario.scenario_id} run=${runId} phase=${phase} interval_ms=${opts.resourceSampleIntervalMs}`);
      resourceSampler = createResourceSampler({
        outFile: resourceSampleFile,
        intervalMs: opts.resourceSampleIntervalMs,
        benchmarkId: opts.benchmarkId,
        scenarioId: scenario.scenario_id,
        runId,
        phase,
        trackedProcesses,
        samplesPath,
      });
      resourceSampler.start();
    }
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
    const protectedResultPayload = queryResult.message?.protected_result || null;
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
      nurse_notification_subscribe_ms: raw.metrics.nurse_notification_subscribe_ms ?? null,
      rsp_output_to_panda_result_write_ms: null,
      panda_result_write_total_ms: null,
      panda_result_write_to_notification_ms: null,
      nurse_notification_to_uma_get_start_ms: null,
      nurse_result_uma_challenge_ms: null,
      nurse_result_token_exchange_ms: null,
      nurse_result_authorized_get_ms: null,
      nurse_result_total_read_ms: null,
      end_to_end_replayer_to_rsp_output_ms: queryResult.firstResultAt - replayerStartedAt,
      end_to_end_replayer_to_nurse_result_read_ms: null,
      query_registration_to_nurse_result_read_ms: null,
    };
    if (serverFirstResult && serverSent) {
      raw.metrics.rsp_first_any_result_emit_processing_ms = raw.metrics.rsp_first_any_result_emit_processing_ms ?? nsDiffMs(serverFirstResult, serverSent);
    }
    raw.client_result_delivery = queryResult.clientResultDelivery;
    raw.message_query_hash = queryResult.message?.query_hash || null;
    raw.early_result_ignored_reasons_summary = queryResult.earlyResultIgnoredReasonsSummary;
    raw.early_result_ignored_samples = opts.mode === 'smoke' ? queryResult.earlyResultIgnoredSamples : undefined;
    Object.assign(raw, acceptedResultDebugFields(queryResult.acceptedResultEvidence));
    Object.assign(raw, aggregationWindowDebugFields(queryResult.message, 'accepted_result'));
    Object.assign(raw, firstAnyResultDebugFields(queryResult.firstAnyResultEvidence));
    Object.assign(raw, ignoredResultDebugFields(queryResult.lastIgnoredPartialEvidence));
    raw.run_isolation = buildRunIsolationEvidence(raw.metrics);
    raw.critical_path_timeline = buildCriticalPathTimeline(events, queryResult, timing);
    attachMetricDefinitions(raw);
    if (protectedResultConfig) {
      raw.protected_result_flow = {
        ...raw.protected_result_flow,
        websocket_protected_result: protectedResultPayload,
      };
      const writeStartedNs = parseNs(timing.protected_result_write_started_at_ns);
      const writeCompletedNs = parseNs(timing.protected_result_write_completed_at_ns);
      const protectedSourceNs = parseNs(timing.protected_result_source_emitted_at_ns);
      raw.metrics.rsp_output_to_panda_result_write_ms = nsDiffMs(protectedSourceNs, writeCompletedNs);
      raw.metrics.panda_result_write_total_ms = nsDiffMs(writeStartedNs, writeCompletedNs);
      if (writeCompletedNs) {
        const writeCompletedRelMs = nsDiffMs(parseNs(timing.query_registered_at_ns), writeCompletedNs);
        if (Number.isFinite(writeCompletedRelMs)) {
          markEvent('panda_protected_result_written');
          sequence.panda_protected_result_written = addMsToIso(queryResult.querySendWall, writeCompletedRelMs);
        }
      }

      const notification = await protectedObserver.waitForNotification(Math.max(120000, (opts.queryWindow + 60) * 1000));
      markEvent('nurse_notification_received');
      sequence.nurse_notification_received = notification.received_at;
      raw.protected_result_flow.notification_received = notification;
      const notificationTimeMs = Date.parse(notification.received_at);
      const writeCompletedAtIso = protectedResultPayload?.created_at || sequence.panda_protected_result_written || null;
      const writeCompletedAtMs = writeCompletedAtIso ? Date.parse(writeCompletedAtIso) : NaN;
      raw.metrics.panda_result_write_to_notification_ms = Number.isFinite(writeCompletedAtMs)
        ? Math.max(0, notificationTimeMs - writeCompletedAtMs)
        : null;

      markEvent('nurse_result_uma_get_start');
      raw.metrics.nurse_notification_to_uma_get_start_ms = events.nurse_result_uma_get_start.t - events.nurse_notification_received.t;
      const protectedRead = await performProtectedResultUmaRead(protectedResultConfig, uma.umaLogFile);
      markEvent('nurse_result_uma_get_complete');
      sequence.nurse_result_read_completed = isoNow();
      raw.protected_result_flow.nurse_read = protectedRead;
      raw.metrics.nurse_result_uma_challenge_ms = protectedRead.challenge?.durationMs ?? null;
      raw.metrics.nurse_result_token_exchange_ms = protectedRead.token?.durationMs ?? null;
      raw.metrics.nurse_result_authorized_get_ms = protectedRead.authorized?.durationMs ?? null;
      raw.metrics.nurse_result_total_read_ms = (protectedRead.challenge?.durationMs ?? 0)
        + (protectedRead.token?.durationMs ?? 0)
        + (protectedRead.authorized?.durationMs ?? 0);
      raw.metrics.query_registration_to_nurse_result_read_ms = events.nurse_result_uma_get_complete.t - queryResult.querySendAt;
      raw.metrics.end_to_end_replayer_to_nurse_result_read_ms = events.nurse_result_uma_get_complete.t - replayer.startedAtPerf;
      raw.protected_result_flow.returned_body_excerpt = protectedRead.authorized?.body?.slice(0, 320) ?? '';
      raw.protected_result_flow.returned_body_parsed = protectedRead.parsedBody;
      raw.protected_result_flow.odrl_proof = protectedRead.odrlProof;
      raw.protected_result_flow.nurse_get_status = protectedRead.authorized?.status ?? null;
      raw.protected_result_flow.stale_content_detected = Boolean(
        protectedRead.parsedBody
        && protectedRead.parsedBody.benchmarkRunId
        && protectedRead.parsedBody.benchmarkRunId !== benchmarkRunId
      );
    }
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
    if (resourceSampler) {
      resourceSampler.stop(raw.status === 'complete' ? 'scenario_complete' : 'scenario_failed');
      console.log(`[resource] stop scenario=${scenario.scenario_id} run=${runId} phase=${phase}`);
    }
    stopReplayerWatcher();
    stopChild(replayer?.child);
    stopChild(panda?.child);
    stopChild(umaProcess);
    if (protectedObserver) {
      try {
        await protectedObserver.close();
      } catch (_) {
        // ignore observer shutdown failures
      }
    }
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

  // Validate resource samples if collection was enabled
  if (raw.resource_usage?.enabled && raw.status === 'complete') {
    const samplesPath = raw.resource_usage?.samples_path;
    if (samplesPath) {
      const fullPath = path.join(ROOT, samplesPath);
      const validation = validateResourceSamples(fullPath);
      if (!validation.isValid) {
        warnings.push({
          code: 'resource_collection_produced_no_usable_samples',
          message: validation.message,
          samples_path: samplesPath,
        });
      }
    }
  }

  return warnings;
}

// Validate that a resource samples file contains actual sample data
function validateResourceSamples(samplesPath) {
  if (!fs.existsSync(samplesPath)) {
    return { isValid: false, message: `Resource samples file does not exist at ${samplesPath}` };
  }
  
  try {
    const content = fs.readFileSync(samplesPath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    // Look for at least one actual sample record (event: 'sample') with rss_bytes
    let foundUsableSample = false;
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.event === 'sample' && Number.isFinite(record.rss_bytes)) {
          foundUsableSample = true;
          break;
        }
      } catch (_) {
        // Skip malformed lines
      }
    }
    
    if (!foundUsableSample) {
      return { 
        isValid: false, 
        message: 'Resource samples file contains no usable sample records with rss_bytes' 
      };
    }
    
    return { isValid: true };
  } catch (error) {
    return { isValid: false, message: `Error reading resource samples file: ${error?.message || error}` };
  }
}

// Parse and aggregate resource samples from a JSONL file
function aggregateResourceSamples(samplesPath) {
  const stats = {
    total_records: 0,
    sample_records: 0,
    process_exit_records: 0,
    missing_pid_records: 0,
    error_records: 0,
    by_label: {},
  };
  
  if (!fs.existsSync(samplesPath)) {
    return stats;
  }
  
  try {
    const content = fs.readFileSync(samplesPath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        stats.total_records += 1;
        
        const label = record.label;
        if (!stats.by_label[label]) {
          stats.by_label[label] = {
            sample_count: 0,
            rss_bytes_samples: [],
            cpu_percent_samples: [],
            exit_recorded: false,
          };
        }
        
        if (record.event === 'sample') {
          stats.sample_records += 1;
          stats.by_label[label].sample_count += 1;
          if (Number.isFinite(record.rss_bytes)) {
            stats.by_label[label].rss_bytes_samples.push(record.rss_bytes);
          }
          if (Number.isFinite(record.cpu_percent)) {
            stats.by_label[label].cpu_percent_samples.push(record.cpu_percent);
          }
        } else if (record.event === 'process_exit') {
          stats.process_exit_records += 1;
          stats.by_label[label].exit_recorded = true;
        } else if (record.event === 'missing_pid') {
          stats.missing_pid_records += 1;
        } else if (record.event === 'sample_error') {
          stats.error_records += 1;
        }
      } catch (_) {
        // Skip malformed lines
      }
    }
    
    // Compute summary statistics for each label
    for (const label in stats.by_label) {
      const labelStats = stats.by_label[label];
      if (labelStats.rss_bytes_samples.length > 0) {
        const samples = labelStats.rss_bytes_samples;
        labelStats.rss_bytes_mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        labelStats.rss_bytes_min = Math.min(...samples);
        labelStats.rss_bytes_max = Math.max(...samples);
      }
      if (labelStats.cpu_percent_samples.length > 0) {
        const samples = labelStats.cpu_percent_samples;
        labelStats.cpu_percent_mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        labelStats.cpu_percent_min = Math.min(...samples);
        labelStats.cpu_percent_max = Math.max(...samples);
      }
    }
  } catch (error) {
    // Silently ignore errors during aggregation
  }
  
  return stats;
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
    collect_resource_usage: opts.collectResourceUsage,
    resource_sample_interval_ms: opts.resourceSampleIntervalMs,
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
