#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const { Parser, Writer } = require('n3');
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
const LIMITED_FIXTURE_SOURCE_DATASET_PATH = '/Users/kushbisen/Code/stream-aggregator-evaluation-mapper/output/heart-rate-from-ibi-2026-05-13T140357-corrected.nt';
const LIMITED_FIXTURE_PATH = path.join(ROOT, 'benchmarks', 'generated', 'heart-rate-ibi-real-10min.nt');
const LIMITED_FIXTURE_WINDOW_START = '2026-05-13T09:04:47.027000Z';
const LIMITED_QUERY_WINDOW_END = '2026-05-13T09:14:47.027Z';
const LIMITED_FIXTURE_WINDOW_END = '2026-05-13T09:14:48.259Z';
const LIMITED_WINDOW_DURATION_MS = 600000;
const LIMITED_FIXTURE_WINDOW_DURATION_MS = 601232;
const LIMITED_FIXTURE_SOURCE_OBSERVATION_COUNT = 2877;
const LIMITED_FIXTURE_BOUNDED_OBSERVATION_COUNT = 522;
const LIMITED_FIXTURE_IN_WINDOW_OBSERVATION_COUNT = 521;
const LIMITED_LOGICAL_SIGNAL = 'heart_rate_from_ibi';
const LIMITED_PHYSICAL_STREAM_CONTAINER_URL = 'http://localhost:3000/alice/spo2/';
const DEFAULT_EXPECTED_PROPERTY_IRI = 'https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2';
const UMA_DIR = resolveRepoPath({
  cliValue: null,
  envVarName: 'UMA_REPO',
  defaultPath: siblingDefaults.umaRepo,
});
const WS_PROTOCOL = 'solid-stream-aggregator-protocol';
const CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';
const ALICE_WEBID = 'http://localhost:3000/alice/profile/card#me';
const LIMITED_SCENARIO_ID = 'limited-caregiver-time-window-access';
const LIMITED_PROCESSING_SCENARIO_ID = 'limited-caregiver-time-window-processing';
const TIMESTAMP_PREDICATE = 'https://saref.etsi.org/core/hasTimestamp';
const SAREF_HAS_VALUE = 'https://saref.etsi.org/core/hasValue';
const SAREF_MEASUREMENT_MADE_BY = 'https://saref.etsi.org/core/measurementMadeBy';
const SAREF_RELATES_TO_PROPERTY = 'https://saref.etsi.org/core/relatesToProperty';
const LIMITED_DERIVED_METADATA = [
  '@prefix derived: <urn:npm:solid:derived-resources:> .',
  '',
  '<http://localhost:3000/alice/derived/> derived:derivedResource',
  '  <http://localhost:3000/alice/derived/#spo2-last-10-min>.',
  '',
  '<http://localhost:3000/alice/derived/#spo2-last-10-min>',
  '  derived:template "spo2-last-10-min/";',
  '  derived:selector "http://localhost:3000/alice/spo2/*";',
  '  derived:filter "http://localhost:3000/alice/filters/spo2-last-10-min.rq".',
  '',
].join('\n');
const LIMITED_DERIVED_METADATA_PATCH = [
  'PREFIX derived: <urn:npm:solid:derived-resources:>',
  '',
  'INSERT DATA {',
  '  <http://localhost:3000/alice/derived/> derived:derivedResource',
  '    <http://localhost:3000/alice/derived/#spo2-last-10-min>.',
  '',
  '  <http://localhost:3000/alice/derived/#spo2-last-10-min>',
  '    derived:template "spo2-last-10-min/";',
  '    derived:selector "http://localhost:3000/alice/spo2/*";',
  '    derived:filter "http://localhost:3000/alice/filters/spo2-last-10-min.rq".',
  '}',
  '',
].join('\n');
const LIMITED_SPARQL_FILTER = [
  'PREFIX saref: <https://saref.etsi.org/core/>',
  'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
  '',
  'CONSTRUCT {',
  '  ?s ?p ?o .',
  '}',
  'WHERE {',
  '  ?s saref:hasTimestamp ?timestamp .',
  '  ?s ?p ?o .',
  '  FILTER(',
  `    ?timestamp >= "${LIMITED_FIXTURE_WINDOW_START}"^^xsd:dateTime &&`,
  `    ?timestamp <  "${LIMITED_QUERY_WINDOW_END}"^^xsd:dateTime`,
  '  )',
  '}',
  '',
].join('\n');

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
    resourceSampleIntervalMs: 500,
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

function isLimitedCaregiverScenario(scenario) {
  return scenario?.scenario_id === LIMITED_SCENARIO_ID
    || scenario?.scenario_id === LIMITED_PROCESSING_SCENARIO_ID;
}

function isLimitedCaregiverProcessingScenario(scenario) {
  return scenario?.scenario_id === LIMITED_PROCESSING_SCENARIO_ID;
}

function buildResourceUsageLogPath(runRoot, scenarioId, runId, phase) {
  const dir = phase === 'warmup' ? path.join(runRoot, 'warmup') : path.join(runRoot, 'raw');
  return path.join(dir, `${scenarioId}-${phase === 'warmup' ? `warmup-${runId}` : `run-${runId}`}-resource-usage.csv`);
}

function countResourceUsageSamples(file) {
  if (!file || !fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return 0;
  return Math.max(0, text.split('\n').length - 1);
}

function metaContentForScenario(scenario) {
  if (isLimitedCaregiverScenario(scenario)) {
    return new Map([
      ['alice/.meta', '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n'],
      ['alice/spo2/.meta', '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n'],
      ['alice/derived/.meta', LIMITED_DERIVED_METADATA],
      ['alice/filters/.meta', '<> a <http://www.w3.org/ns/ldp#BasicContainer> .\n'],
      ['alice/filters/spo2-last-10-min.rq', LIMITED_SPARQL_FILTER],
    ]);
  }
  return new Map([
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
}

async function createContainersAndPolicies(scenario, cssStatePath, httpStatuses) {
  const startedContainersAt = performance.now();
  const dirs = [
    '',
    'alice',
    'alice/spo2',
    'alice/derived',
    ...(isLimitedCaregiverScenario(scenario) ? ['alice/filters'] : ['alice/derived/anomaly-alert']),
  ];
  for (const dir of dirs) {
    ensureDir(path.join(cssStatePath, dir));
  }
  const containerUrls = [
    'http://localhost:3000/alice/spo2/',
    'http://localhost:3000/alice/derived/',
    ...(isLimitedCaregiverScenario(scenario)
      ? ['http://localhost:3000/alice/filters/']
      : ['http://localhost:3000/alice/derived/anomaly-alert/']),
  ];
  const policy = makeOdrlPolicy(scenario);
  const policyResponse = await fetch('http://localhost:4000/uma/policies', {
    method: 'POST',
    headers: {
      Authorization: `WebID ${encodeURIComponent(ALICE_WEBID)}`,
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
  const metaFiles = metaContentForScenario(scenario);
  for (const [relativePath, content] of metaFiles) {
    fs.writeFileSync(path.join(cssStatePath, relativePath), content);
    const url = `http://localhost:3000/${relativePath}`;
    if (isLimitedCaregiverScenario(scenario) && relativePath === 'alice/derived/.meta') {
      const response = await fetchWithUma(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/sparql-update',
        },
        body: LIMITED_DERIVED_METADATA_PATCH,
      });
      httpStatuses.push({ phase: 'meta_patch', status: response.status, url });
    } else {
      const response = await fetchWithUma(url, {
        method: 'PUT',
        headers: {
          'Content-Type': relativePath.endsWith('.rq') ? 'application/sparql-query' : 'text/turtle',
        },
        body: content,
      });
      httpStatuses.push({ phase: 'meta_put', status: response.status, url });
    }
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
  return exchangeTokenForClaim(tokenEndpoint, ticket, ALICE_WEBID);
}

async function exchangeTokenForClaim(tokenEndpoint, ticket, claimToken) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: encodeURIComponent(claimToken),
      claim_token_format: CLAIM_TOKEN_FORMAT,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`UMA token exchange failed status=${response.status} body=${body}`);
  return JSON.parse(body);
}

function makeOdrlPolicy(scenario) {
  if (isLimitedCaregiverScenario(scenario)) {
    return makeLimitedCaregiverOdrlPolicy(scenario);
  }
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

function makeLimitedCaregiverOdrlPolicy(scenario) {
  const stream = scenario.target_css_resources.stream_container_url;
  const derivedTimeWindow = scenario.target_css_resources.derived_time_window_url;
  const filterResource = scenario.target_css_resources.filter_resource_url;
  const caregiver = scenario.caregiver_actor_webid;
  const owner = ALICE_WEBID;
  const metaTargets = [
    'http://localhost:3000/alice/.meta',
    'http://localhost:3000/alice/spo2/.meta',
    'http://localhost:3000/alice/derived/.meta',
    'http://localhost:3000/alice/filters/.meta',
  ];
  const ownerTargets = [
    { id: 'readStream', target: stream, actions: 'odrl:read' },
    { id: 'writeStream', target: stream, actions: 'odrl:create, odrl:append, odrl:write' },
    { id: 'writeDerived', target: 'http://localhost:3000/alice/derived/', actions: 'odrl:create, odrl:append, odrl:write, odrl:read' },
    { id: 'writeFilters', target: 'http://localhost:3000/alice/filters/', actions: 'odrl:create, odrl:append, odrl:write, odrl:read' },
    { id: 'writeFilterFile', target: filterResource, actions: 'odrl:create, odrl:append, odrl:write, odrl:read' },
    { id: 'readDerivedTimeWindowOwner', target: derivedTimeWindow, actions: 'odrl:read' },
  ];
  const ownerPermissions = ownerTargets.map(({ id, target, actions }) => `
ex:${id} a odrl:Permission ;
  odrl:target <${target}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${owner}> ;
  odrl:action ${actions} .
`).join('\n');
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
  odrl:permission ex:caregiverReadDerivedTimeWindow${ownerTargets.map(({ id }) => `, ex:${id}`).join('')}${metaTargets.map((_, index) => `, ex:writeMeta${index}`).join('')} .

ex:caregiverReadDerivedTimeWindow a odrl:Permission ;
  odrl:target <${derivedTimeWindow}> ;
  odrl:assigner <${owner}> ;
  odrl:assignee <${caregiver}> ;
  odrl:action odrl:read .
${ownerPermissions}
${metaPermissions}
`.trim();
}

async function startPanda(opts, runRoot, scenarioId, runId, phase, benchmarkControl = {}, expectedPropertyIri = DEFAULT_EXPECTED_PROPERTY_IRI) {
  const logDir = phase === 'warmup' ? path.join(runRoot, 'warmup') : path.join(runRoot, 'raw');
  const logFile = path.join(logDir, `panda-run-${runId}.log`);
  const resourceUsageLogFile = opts.collectResourceUsage
    ? buildResourceUsageLogPath(runRoot, scenarioId, runId, phase)
    : null;
  const benchmarkControlEnabled = benchmarkControl.enabled === true;
  const benchmarkControlToken = typeof benchmarkControl.token === 'string' ? benchmarkControl.token : '';
  const startedAt = performance.now();
  const child = spawnLogged('npm', ['run', 'start-monitoring'], {
    cwd: ROOT,
    env: {
      ...process.env,
      BENCHMARK_TIMING: '1',
      PANDA_EXPECTED_PROPERTY_IRI: expectedPropertyIri,
      ...(benchmarkControlEnabled ? {
        PANDA_BENCHMARK_CONTROL_ENABLED: 'true',
        PANDA_BENCHMARK_CONTROL_TOKEN: benchmarkControlToken,
      } : {}),
      ...(resourceUsageLogFile ? {
        PANDA_RESOURCE_USAGE_LOG_FILE: resourceUsageLogFile,
        PANDA_RESOURCE_USAGE_INTERVAL_MS: String(opts.resourceSampleIntervalMs || 500),
      } : {}),
    },
  }, logFile);
  await waitForHttp('http://localhost:8080/', 120000);
  return {
    child,
    logFile,
    ms: performance.now() - startedAt,
    resourceUsageLogFile,
  };
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

function loadRealFixtureObservations(fixturePath, loadWindowStartIso, loadWindowEndIso) {
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Missing bounded fixture at ${fixturePath}`);
  }
  const fixtureText = fs.readFileSync(fixturePath, 'utf8');
  const subjectOrder = [];
  const subjects = new Map();
  for (const line of fixtureText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^<([^>]+)>\s+<([^>]+)>\s+(.+)\s+\.\s*$/);
    if (!match) continue;
    const [, subject, predicate, object] = match;
    let entry = subjects.get(subject);
    if (!entry) {
      entry = {
        subject,
        lines: [],
        timestamp: null,
        value: null,
      };
      subjects.set(subject, entry);
      subjectOrder.push(subject);
    }
    entry.lines.push(line);
    if (predicate === TIMESTAMP_PREDICATE) {
      entry.timestamp = object.match(/"([^"]+)"/)?.[1] || null;
    } else if (predicate === SAREF_HAS_VALUE) {
      entry.value = object.match(/"([^"]+)"/)?.[1] || null;
    }
  }
  const windowStartMs = Date.parse(loadWindowStartIso);
  const windowEndMs = Date.parse(loadWindowEndIso);
  const observations = subjectOrder.map((subject) => {
    const entry = subjects.get(subject);
    return {
      subject,
      timestamp: entry.timestamp,
      value: entry.value,
      payload: `${entry.lines.join('\n')}\n`,
    };
  }).filter((entry) => entry.timestamp && Number.isFinite(Date.parse(entry.timestamp)))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (observations.length === 0) {
    throw new Error(`No observations were loaded from bounded fixture ${fixturePath}`);
  }
  for (const observation of observations) {
    const timestampMs = Date.parse(observation.timestamp);
    if (timestampMs < windowStartMs || timestampMs >= windowEndMs) {
      throw new Error(`Bounded fixture observation ${observation.subject} falls outside the configured fixture window`);
    }
  }
  return {
    observations,
    sourceObservationCount: LIMITED_FIXTURE_SOURCE_OBSERVATION_COUNT,
    sourceFixtureObservationCount: subjectOrder.length,
    boundedFixtureObservationCount: observations.length,
    boundedViewObservationCount: observations.length,
    boundedFixtureWindowStart: loadWindowStartIso,
    boundedFixtureWindowEnd: loadWindowEndIso,
    boundedFixtureDurationMs: windowEndMs - windowStartMs,
  };
}

async function postObservationFixture(fixture, sourceStreamUrl, httpStatuses, phase, windowStartIso, windowEndIso) {
  const startedAt = performance.now();
  const windowStartMs = Date.parse(windowStartIso);
  const windowEndMs = Date.parse(windowEndIso);
  let inWindowEventsWrittenCount = 0;
  let outOfWindowEventsWrittenCount = 0;
  for (const observation of fixture.observations) {
    const timestampMs = Date.parse(observation.timestamp);
    if (timestampMs >= windowStartMs && timestampMs < windowEndMs) {
      inWindowEventsWrittenCount += 1;
    } else {
      outOfWindowEventsWrittenCount += 1;
    }
    const response = await postWithClaimUma(
      sourceStreamUrl,
      observation.payload,
      ALICE_WEBID,
      httpStatuses,
      phase,
    );
    if (!(response.status >= 200 && response.status < 300)) {
      const body = await response.text().catch(() => '');
      throw new Error(`Failed to post real fixture observation ${observation.subject}: status=${response.status} body=${body}`);
    }
  }
  return {
    preloadMs: performance.now() - startedAt,
    sourceEventsWrittenCount: fixture.observations.length,
    inWindowEventsWrittenCount,
    outOfWindowEventsWrittenCount,
    expectedDerivedObservationCount: inWindowEventsWrittenCount,
  };
}

async function postWithClaimUma(url, body, claimToken, httpStatuses, phase) {
  const stateByClaim = postWithClaimUma.state || new Map();
  postWithClaimUma.state = stateByClaim;
  const state = stateByClaim.get(claimToken) || { token: null };
  stateByClaim.set(claimToken, state);
  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      ...(state.token ? { Authorization: `${state.token.token_type || 'Bearer'} ${state.token.access_token}` } : {}),
    },
    body,
  });
  httpStatuses.push({ phase: `${phase}_initial_post`, status: response.status, url });
  if (response.ok) return response;
  if (response.status !== 401 && response.status !== 403) {
    return response;
  }
  const challenge = parseAuthenticateHeader(response.headers.get('WWW-Authenticate'));
  state.token = await exchangeTokenForClaim(challenge.tokenEndpoint, challenge.ticket, claimToken);
  httpStatuses.push({ phase: `${phase}_token_exchange`, status: 200, url: challenge.tokenEndpoint });
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      Authorization: `${state.token.token_type || 'Bearer'} ${state.token.access_token}`,
    },
    body,
  });
  httpStatuses.push({ phase: `${phase}_authorized_post`, status: response.status, url });
  return response;
}

async function fetchWithClaimUma(url, claimToken, httpStatuses, phase) {
  const trace = {
    initialChallengeMs: null,
    tokenExchangeMs: null,
    authorizedGetMs: null,
    totalLatencyMs: null,
    usedClaimToken: false,
    initialStatus: null,
    tokenExchangeStatus: null,
    finalStatus: null,
    body: '',
    finalResponseHeaders: {},
  };
  const startedAt = performance.now();
  const challengeStartedAt = performance.now();
  let response = await fetch(url, {
    headers: {
      Accept: 'text/turtle',
    },
  });
  trace.initialChallengeMs = performance.now() - challengeStartedAt;
  trace.initialStatus = response.status;
  httpStatuses.push({
    phase: `${phase}_challenge`,
    status: response.status,
    url,
    www_authenticate: response.headers.get('WWW-Authenticate') || undefined,
  });
  if (response.ok || (response.status !== 401 && response.status !== 403)) {
    trace.finalStatus = response.status;
    trace.body = await response.text().catch(() => '');
    trace.totalLatencyMs = performance.now() - startedAt;
    return trace;
  }

  trace.usedClaimToken = true;
  const challenge = parseAuthenticateHeader(response.headers.get('WWW-Authenticate'));
  const tokenStartedAt = performance.now();
  let tokenBody = null;
  try {
    const tokenResponse = await fetch(challenge.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
        ticket: challenge.ticket,
        claim_token: encodeURIComponent(claimToken),
        claim_token_format: CLAIM_TOKEN_FORMAT,
      }),
    });
    trace.tokenExchangeMs = performance.now() - tokenStartedAt;
    trace.tokenExchangeStatus = tokenResponse.status;
    tokenBody = await tokenResponse.text().catch(() => '');
    httpStatuses.push({ phase: `${phase}_token_exchange`, status: tokenResponse.status, url: challenge.tokenEndpoint });
    if (!tokenResponse.ok) {
      trace.finalStatus = tokenResponse.status;
      trace.body = tokenBody;
      trace.totalLatencyMs = performance.now() - startedAt;
      return trace;
    }
  } catch (error) {
    trace.tokenExchangeMs = performance.now() - tokenStartedAt;
    trace.finalStatus = 0;
    trace.body = String(error?.message || error);
    trace.totalLatencyMs = performance.now() - startedAt;
    return trace;
  }

  const token = JSON.parse(tokenBody);
  const authorizedStartedAt = performance.now();
  response = await fetch(url, {
    headers: {
      Accept: 'text/turtle',
      Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`,
    },
  });
  trace.authorizedGetMs = performance.now() - authorizedStartedAt;
  trace.finalStatus = response.status;
  trace.finalResponseHeaders = {
    contentType: response.headers.get('Content-Type') || null,
  };
  httpStatuses.push({ phase: `${phase}_authorized_get`, status: response.status, url });
  trace.body = await response.text().catch(() => '');
  trace.totalLatencyMs = performance.now() - startedAt;
  return trace;
}

function parseDerivedObservationPayload(text, windowStartIso, windowEndIso, outOfWindowSubjects = []) {
  const parseStartedAt = performance.now();
  const parser = new Parser({ baseIRI: 'http://localhost:3000/alice/derived/spo2-last-10-min/' });
  const quads = parser.parse(text);
  const parseMs = performance.now() - parseStartedAt;
  const validationStartedAt = performance.now();
  const observationMap = new Map();
  const outOfWindowSubjectSet = new Set(outOfWindowSubjects);
  for (const quad of quads) {
    const subject = quad.subject.value;
    const predicate = quad.predicate.value;
    if (!observationMap.has(subject)) {
      observationMap.set(subject, {
        subject,
        quads: [],
        timestamp: null,
        timestampMs: null,
      });
    }
    const observation = observationMap.get(subject);
    observation.quads.push(quad);
    if ([TIMESTAMP_PREDICATE, SAREF_HAS_VALUE, SAREF_MEASUREMENT_MADE_BY, SAREF_RELATES_TO_PROPERTY].includes(predicate)) {
      observation.isObservation = true;
    }
    if (predicate === TIMESTAMP_PREDICATE) {
      observation.timestamp = quad.object.value;
      observation.timestampMs = Date.parse(quad.object.value);
    }
  }
  const windowStartMs = Date.parse(windowStartIso);
  const windowEndMs = Date.parse(windowEndIso);
  const timestamps = [];
  const observations = [];
  const returnedOutOfWindowSubjects = [];
  const subjectsMissingTimestamp = [];
  const subjectsOutsideWindow = [];
  let missingTimestampCount = 0;
  let parseFailure = false;
  for (const observation of observationMap.values()) {
    if (!observation.isObservation) continue;
    if (!observation.timestamp) {
      missingTimestampCount += 1;
      subjectsMissingTimestamp.push(observation.subject);
      continue;
    }
    if (!Number.isFinite(observation.timestampMs)) {
      parseFailure = true;
      subjectsOutsideWindow.push(observation.subject);
      continue;
    }
    if (observation.timestampMs < windowStartMs || observation.timestampMs >= windowEndMs) {
      subjectsOutsideWindow.push(observation.subject);
    }
    if (outOfWindowSubjectSet.has(observation.subject)) {
      returnedOutOfWindowSubjects.push(observation.subject);
    }
    observations.push(observation);
    timestamps.push(observation.timestampMs);
  }
  const returnedObservationsWithinWindow = timestamps.every((timestampMs) => (
    timestampMs >= windowStartMs && timestampMs < windowEndMs
  ));
  const validationMs = performance.now() - validationStartedAt;
  return {
    quads,
    parseMs,
    validationMs,
    observations: observations.sort((left, right) => left.timestampMs - right.timestampMs),
    observationCount: observations.length,
    timestamps,
    missingTimestampCount,
    subjectsMissingTimestamp,
    subjectsOutsideWindow,
    returnedOutOfWindowSubjects,
    parseFailure,
    returnedObservationsWithinWindow,
    minTimestamp: timestamps.length > 0 ? isoFromTimestampMs(Math.min(...timestamps)) : null,
    maxTimestamp: timestamps.length > 0 ? isoFromTimestampMs(Math.max(...timestamps)) : null,
  };
}

async function waitForDerivedWindowContent(url, caregiverWebId, windowStartIso, windowEndIso, httpStatuses, outOfWindowSubjects = []) {
  const startedAt = performance.now();
  let lastAttempt = null;
  while (performance.now() - startedAt < 30000) {
    lastAttempt = await fetchWithClaimUma(url, caregiverWebId, httpStatuses, 'derived_time_window_wait');
    if (lastAttempt.finalStatus >= 200 && lastAttempt.finalStatus < 300 && lastAttempt.body.trim()) {
      try {
        const parsed = parseDerivedObservationPayload(lastAttempt.body, windowStartIso, windowEndIso, outOfWindowSubjects);
        if (parsed.observationCount > 0) {
          return { fetchTrace: lastAttempt, parsed };
        }
      } catch (_) {
        // keep polling until the derived view materializes valid RDF
      }
    }
    await sleep(1000);
  }
  return { fetchTrace: lastAttempt, parsed: null };
}

async function ingestBoundedDerivedViewAtPanda(derivedTimeWindowUrl, derivedViewBody, httpStatuses, options = {}) {
  const response = await fetch('http://localhost:8080/benchmark/derived-view-ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      'X-Benchmark-Target': derivedTimeWindowUrl,
      ...(options.benchmarkControlToken ? { 'X-Benchmark-Control-Token': options.benchmarkControlToken } : {}),
      ...(options.windowCloseMarkerTimestamp ? {
        'X-Benchmark-Window-Close-Marker-Timestamp': options.windowCloseMarkerTimestamp,
      } : {}),
    },
    body: derivedViewBody,
  });
  httpStatuses.push({ phase: 'derived_processing_bounded_batch_post', status: response.status, url: 'http://localhost:8080/benchmark/derived-view-ingest' });
  if (!(response.status >= 200 && response.status < 300)) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to ingest bounded derived view via PANDA benchmark endpoint: status=${response.status} body=${body}`);
  }
}

function requiredResultWindowMsForScenario(scenario, opts) {
  if (isLimitedCaregiverProcessingScenario(scenario)) {
    return Math.max(0, Number(scenario?.limited_window?.duration_ms || 0));
  }
  return opts.queryWindow * 1000;
}

function registerQueryAndWait(scenario, opts, benchmarkRunId, requiredWindowMs = opts.queryWindow * 1000) {
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
        const evidence = buildResultWindowEvidence(parsed, now, result.querySendAt, requiredWindowMs);
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

function buildResultWindowEvidence(parsed, now, querySendAt, requiredWindowMs) {
  const timing = parsed?.benchmark_timing || {};
  const metrics = timing.metrics || {};
  const requiredSpanMs = requiredWindowMs;
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
    limited_access_total_latency_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'limited_derived_access_start',
      end_event: 'limited_derived_access_end',
      interpretation: 'End-to-end caregiver UMA latency to access the fixed derived time-window resource.',
      critical_path: true,
      notes: 'Scenario specific to limited-caregiver-time-window-access.',
    },
    limited_access_initial_challenge_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'limited_derived_challenge_start',
      end_event: 'limited_derived_challenge_end',
      interpretation: 'Unauthenticated caregiver GET latency until the derived resource returns a UMA challenge.',
      critical_path: true,
      notes: 'Scenario specific to limited-caregiver-time-window-access.',
    },
    limited_access_token_exchange_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'limited_derived_token_exchange_start',
      end_event: 'limited_derived_token_exchange_end',
      interpretation: 'Caregiver UMA ticket-to-token exchange latency for the fixed derived time-window resource.',
      critical_path: true,
      notes: 'Scenario specific to limited-caregiver-time-window-access.',
    },
    limited_access_authorized_get_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'limited_derived_authorized_get_start',
      end_event: 'limited_derived_authorized_get_end',
      interpretation: 'Authorized caregiver GET latency for the fixed derived time-window resource after token issuance.',
      critical_path: true,
      notes: 'Scenario specific to limited-caregiver-time-window-access.',
    },
    full_stream_denial_latency_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'full_stream_denial_start',
      end_event: 'full_stream_denial_end',
      interpretation: 'Elapsed caregiver UMA flow latency until denial is established for the full legacy source stream.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-access; only present when measured.',
    },
    derived_time_window_fetch_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'derived_time_window_fetch_start',
      end_event: 'derived_time_window_fetch_end',
      interpretation: 'Distinct fetch stage for the fixed derived time-window resource when measured separately.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-access and may be unavailable when duplicated by limited_access_total_latency_ms.',
    },
    derived_time_window_validation_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'derived_time_window_validation_start',
      end_event: 'derived_time_window_validation_end',
      interpretation: 'RDF parsing and timestamp-window validation latency for the caregiver-visible derived view.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-access.',
    },
    limited_window_duration_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'limited_window_start',
      end_event: 'limited_window_end',
      interpretation: 'Configured fixed replay-time interval width for the derived resource benchmark.',
      critical_path: false,
      notes: 'Scenario metadata for limited-caregiver-time-window-access.',
    },
    returned_observation_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'derived_time_window_validation_start',
      end_event: 'derived_time_window_validation_end',
      interpretation: 'Number of derived-view heart-rate-from-IBI observations returned to the caregiver after timestamp validation.',
      critical_path: false,
      notes: 'Scenario metadata for limited-caregiver-time-window-access.',
    },
    preload_observations_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'preload_observations_start',
      end_event: 'preload_observations_end',
      interpretation: 'Wall-clock duration to post the real 10-minute heart-rate-from-IBI fixture into the legacy source stream.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-processing.',
    },
    derived_view_fetch_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'derived_time_window_fetch_start',
      end_event: 'derived_time_window_fetch_end',
      interpretation: 'Authorized UMA/ODRL fetch latency for the bounded derived RDF view before PANDA ingests it.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-processing.',
    },
    derived_view_payload_size_bytes: {
      unit: 'bytes',
      type: 'direct',
      start_event: 'derived_time_window_fetch_end',
      end_event: 'derived_processing_bounded_batch_post_start',
      interpretation: 'Size of the fetched bounded derived RDF payload in bytes.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-processing.',
    },
    derived_view_parse_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'derived_processing_bounded_batch_post_start',
      end_event: 'derived_processing_bounded_batch_post_end',
      interpretation: 'PANDA-side parse time for the bounded derived RDF view.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-processing.',
    },
    derived_view_observation_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'derived_processing_bounded_batch_post_start',
      end_event: 'derived_processing_bounded_batch_post_end',
      interpretation: 'Number of heart-rate-from-IBI observations PANDA parsed from the bounded derived RDF view.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-processing.',
    },
    bounded_observation_ingest_total_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'derived_processing_bounded_batch_post_start',
      end_event: 'derived_processing_bounded_batch_post_end',
      interpretation: 'Total wall-clock time for PANDA to ingest the bounded derived observations into the RSP engine.',
      critical_path: true,
      notes: 'Scenario specific to limited-caregiver-time-window-processing.',
    },
    bounded_observation_ingest_mean_ms: {
      unit: 'ms',
      type: 'derived',
      start_event: 'derived_processing_bounded_batch_post_start',
      end_event: 'derived_processing_bounded_batch_post_end',
      interpretation: 'Mean per-observation ingest time while PANDA inserts the bounded derived observations into the RSP engine.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-processing.',
    },
    rsp_first_result_emit_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'query_registered_at_server',
      end_event: 'rsp_first_result_emit_ms',
      interpretation: 'Server-side duration from query registration to the first emitted RSP result for the bounded derived-view processing scenario.',
      critical_path: true,
      notes: 'Scenario specific to limited-caregiver-time-window-processing.',
    },
    rule_evaluation_ms: {
      unit: 'ms',
      type: 'direct',
      start_event: 'rule_eval_started_at_ns',
      end_event: 'rule_eval_finished_at_ns',
      interpretation: 'Server-side duration of the first rule evaluation when the anomaly rule executes.',
      critical_path: false,
      notes: 'Scenario specific to limited-caregiver-time-window-processing; unavailable when no rule evaluation timestamps are emitted.',
    },
    source_events_written_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'preload_observations_start',
      end_event: 'preload_observations_end',
      interpretation: 'Number of real fixture observations written into the source stream during bounded fixture load.',
      critical_path: false,
      notes: 'Scenario metadata for limited-caregiver-time-window-processing.',
    },
    in_window_events_written_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'preload_observations_start',
      end_event: 'preload_observations_end',
      interpretation: 'Number of real fixture observations written inside the configured 10-minute replay-time interval.',
      critical_path: false,
      notes: 'Scenario metadata for limited-caregiver-time-window-processing.',
    },
    out_of_window_events_written_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'preload_observations_start',
      end_event: 'preload_observations_end',
      interpretation: 'Number of control observations written outside the configured half-open replay-time interval.',
      critical_path: false,
      notes: 'Scenario metadata for limited-caregiver-time-window-processing.',
    },
    expected_derived_observation_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'limited_window_start',
      end_event: 'limited_window_end',
      interpretation: 'Expected number of in-window observations returned by the real derived time-window view.',
      critical_path: false,
      notes: 'Scenario metadata for limited-caregiver-time-window-processing.',
    },
    rsp_result_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'query_register_start',
      end_event: 'client_first_valid_result_received',
      interpretation: 'Number of monitoring results observed by the benchmark client for the bounded derived-view processing scenario.',
      critical_path: true,
      notes: 'Scenario metadata for limited-caregiver-time-window-processing.',
    },
    resource_usage_sample_count: {
      unit: 'count',
      type: 'counter',
      start_event: 'panda_ready',
      end_event: 'run_complete',
      interpretation: 'Number of PANDA resource-usage samples captured in the per-run CSV file.',
      critical_path: false,
      notes: 'Only present when --collect-resource-usage is enabled.',
    },
  };
}

function attachMetricDefinitions(raw) {
  const definitions = metricDefinitions();
  raw.metric_definitions = {};
  const scenarioNumericFields = Object.keys(raw).filter((key) => (
    typeof raw[key] === 'number'
    && Number.isFinite(raw[key])
    && [
      'limited_window_duration_ms',
      'source_events_written_count',
      'in_window_events_written_count',
      'out_of_window_events_written_count',
      'expected_derived_observation_count',
      'returned_observation_count',
      'rsp_event_add_count_total',
      'rsp_result_count',
      'resource_usage_sample_count',
    ].includes(key)
  ));
  const metricNames = new Set([
    ...Object.keys(raw.metrics || {}),
    ...aggregateDebugFieldNames(raw),
    ...scenarioNumericFields,
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

async function runLimitedCaregiverTimeWindowProcessingScenario(scenario, opts, runRoot, runId, phase) {
  const isWarmup = phase === 'warmup';
  const benchmarkRunId = `${scenario.scenario_id}-${isWarmup ? `warmup-${runId}` : runId}-${randomUUID()}`;
  const benchmarkControlToken = randomUUID();
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
    expected_decision: scenario.expected_decision,
    scenario_file_path: scenario.__scenario_file || null,
    run_id: runId,
    phase,
    mode: opts.mode,
    deployment_mode: 'single_machine',
    query_window_seconds: Math.round((scenario.limited_window.duration_ms || 0) / 1000),
    replayer_duration_seconds: 0,
    query_registration_delay_seconds: 0,
    started_at: isoNow(),
    completed_at: null,
    status: 'running',
    validation_warnings: [],
    sequence,
    metrics: {},
    http_statuses: httpStatuses,
    log_markers_found: [],
    output_check: { passed: false, details: {} },
    caregiver_actor_webid: scenario.caregiver_actor_webid,
    caregiver_requester_used: false,
    source_stream_url: scenario.target_css_resources.stream_container_url,
    derived_time_window_url: scenario.target_css_resources.derived_time_window_url,
    filter_resource_url: scenario.target_css_resources.filter_resource_url,
    limited_window_start: scenario.limited_window.start,
    limited_window_end: scenario.limited_window.end,
    limited_window_duration_ms: scenario.limited_window.duration_ms,
    source_events_written_count: 0,
    in_window_events_written_count: 0,
    out_of_window_events_written_count: 0,
    expected_derived_observation_count: scenario.expected_in_window_observation_count || LIMITED_FIXTURE_IN_WINDOW_OBSERVATION_COUNT,
    source_dataset_path: LIMITED_FIXTURE_SOURCE_DATASET_PATH,
    bounded_fixture_path: LIMITED_FIXTURE_PATH,
    source_fixture_path: LIMITED_FIXTURE_PATH,
    source_observation_count: LIMITED_FIXTURE_SOURCE_OBSERVATION_COUNT,
    source_fixture_observation_count: 0,
    bounded_fixture_observation_count: 0,
    bounded_view_observation_count: 0,
    out_of_window_observation_count: 0,
    bounded_fixture_window_start: LIMITED_FIXTURE_WINDOW_START,
    bounded_fixture_window_end: LIMITED_FIXTURE_WINDOW_END,
    bounded_fixture_duration_ms: LIMITED_FIXTURE_WINDOW_DURATION_MS,
    stream_container_reused_for_compatibility: true,
    logical_signal: LIMITED_LOGICAL_SIGNAL,
    expected_property_iri: scenario.expected_property_iri || DEFAULT_EXPECTED_PROPERTY_IRI,
    physical_stream_container_url: LIMITED_PHYSICAL_STREAM_CONTAINER_URL,
    full_stream_publicly_readable: null,
    derived_time_window_resource_publicly_readable: null,
    caregiver_can_access_full_stream: false,
    caregiver_can_access_derived_time_window: false,
    fake_replayer_used: false,
    data_source_mode: 'real_fixture_10min',
    derived_time_window_content_returned: false,
    full_stream_content_returned_to_caregiver: false,
    returned_observation_count: 0,
    returned_observation_min_timestamp: null,
    returned_observation_max_timestamp: null,
    returned_observations_within_window: false,
    out_of_window_observations_returned: [],
    content_matches_time_window: false,
    rsp_event_add_count_total: 0,
    rsp_result_count: 0,
    monitoring_result_produced: false,
    anomaly_result_generated: false,
    expected_anomaly: scenario.expect_anomaly === true,
    scenario_passed: false,
    resource_usage_enabled: opts.collectResourceUsage,
    resource_usage_log_file: null,
    resource_usage_sample_count: 0,
    benchmark_control_enabled: true,
    benchmark_control_token_configured: true,
  };
  let panda;
  let umaProcess;
  const events = {};
  const markEvent = (event, notes = '') => {
    events[event] = { t: performance.now(), timestamp: isoNow(), notes };
  };
  try {
    killPortsIfForced(opts.force, [3000, 4000, 8080]);
    await sleep(opts.force ? 2000 : 0);

    markEvent('css_uma_start_start');
    const uma = await startUma(opts, runRoot, runId);
    umaProcess = uma.child;
    markEvent('css_uma_ready');
    sequence.css_uma_started = isoNow();
    raw.metrics.css_uma_startup_ms = uma.ms;

    markEvent('container_creation_start');
    const setup = await createContainersAndPolicies(scenario, uma.cssStatePath, httpStatuses);
    markEvent('containers_created');
    sequence.containers_created = isoNow();
    markEvent('meta_policy_write_start');
    markEvent('meta_policies_written');
    sequence.meta_policies_written = isoNow();
    raw.metrics.container_creation_ms = setup.containerCreationMs;
    raw.metrics.meta_policy_write_ms = setup.metaPolicyWriteMs;

    markEvent('panda_start_start');
    panda = await startPanda(opts, runRoot, scenario.scenario_id, runId, phase, {
      enabled: true,
      token: benchmarkControlToken,
    }, scenario.expected_property_iri || DEFAULT_EXPECTED_PROPERTY_IRI);
    markEvent('panda_ready');
    sequence.panda_started = isoNow();
    raw.metrics.panda_startup_ms = panda.ms;
    raw.resource_usage_log_file = panda.resourceUsageLogFile;

    const fixture = loadRealFixtureObservations(
      LIMITED_FIXTURE_PATH,
      LIMITED_FIXTURE_WINDOW_START,
      LIMITED_FIXTURE_WINDOW_END,
    );
    raw.source_fixture_observation_count = fixture.sourceFixtureObservationCount;
    raw.bounded_fixture_observation_count = fixture.boundedFixtureObservationCount;
    raw.bounded_view_observation_count = fixture.boundedViewObservationCount;
    raw.out_of_window_observation_count = fixture.sourceFixtureObservationCount - fixture.boundedViewObservationCount;
    raw.expected_derived_observation_count = fixture.boundedFixtureObservationCount;

    markEvent('preload_observations_start');
    const preload = await postObservationFixture(
      fixture,
      raw.source_stream_url,
      httpStatuses,
      'limited_processing_preload',
      raw.limited_window_start,
      raw.limited_window_end,
    );
    markEvent('preload_observations_end');
    raw.metrics.preload_observations_ms = preload.preloadMs;
    raw.source_events_written_count = preload.sourceEventsWrittenCount;
    raw.in_window_events_written_count = preload.inWindowEventsWrittenCount;
    raw.out_of_window_events_written_count = preload.outOfWindowEventsWrittenCount;
    raw.bounded_view_observation_count = preload.inWindowEventsWrittenCount;
    raw.out_of_window_observation_count = raw.source_fixture_observation_count - preload.inWindowEventsWrittenCount;
    raw.expected_derived_observation_count = preload.expectedDerivedObservationCount;
    raw.replayer_process = {
      command: 'real_fixture_10min_nt_post',
      requested_duration_seconds: 0,
      process_started_at: events.preload_observations_start.timestamp,
      process_exit_at: events.preload_observations_end.timestamp,
      exit_code: 0,
      exit_signal: null,
      actual_process_runtime_ms: preload.preloadMs,
      observations_posted: preload.sourceEventsWrittenCount,
      source_dataset_path: LIMITED_FIXTURE_SOURCE_DATASET_PATH,
      bounded_fixture_path: LIMITED_FIXTURE_PATH,
    };

    const publicFullResponse = await fetch(raw.source_stream_url, {
      headers: { Accept: 'text/turtle' },
    });
    httpStatuses.push({ phase: 'full_stream_public_probe', status: publicFullResponse.status, url: raw.source_stream_url });
    raw.full_stream_publicly_readable = publicFullResponse.ok;

    const publicDerivedResponse = await fetch(raw.derived_time_window_url, {
      headers: { Accept: 'text/turtle' },
    });
    httpStatuses.push({
      phase: 'derived_time_window_public_probe',
      status: publicDerivedResponse.status,
      url: raw.derived_time_window_url,
      www_authenticate: publicDerivedResponse.headers.get('WWW-Authenticate') || undefined,
    });
    raw.derived_time_window_resource_publicly_readable = publicDerivedResponse.ok;

    const denialTrace = await fetchWithClaimUma(
      raw.source_stream_url,
      raw.caregiver_actor_webid,
      httpStatuses,
      'caregiver_full_stream',
    );
    raw.caregiver_requester_used = raw.caregiver_requester_used || denialTrace.usedClaimToken;
    raw.caregiver_can_access_full_stream = denialTrace.finalStatus >= 200 && denialTrace.finalStatus < 300;
    raw.full_stream_content_returned_to_caregiver = raw.caregiver_can_access_full_stream && Boolean(denialTrace.body.trim());
    raw.metrics.full_stream_denial_latency_ms = raw.caregiver_can_access_full_stream ? null : denialTrace.totalLatencyMs;

    markEvent('derived_time_window_fetch_start');
    const derivedTrace = await fetchWithClaimUma(
      raw.derived_time_window_url,
      raw.caregiver_actor_webid,
      httpStatuses,
      'derived_time_window_wait',
    );
    markEvent('derived_time_window_fetch_end');
    raw.metrics.derived_time_window_fetch_ms = events.derived_time_window_fetch_end.t - events.derived_time_window_fetch_start.t;
    raw.caregiver_requester_used = raw.caregiver_requester_used || Boolean(derivedTrace.usedClaimToken);
    raw.caregiver_can_access_derived_time_window = derivedTrace.finalStatus >= 200 && derivedTrace.finalStatus < 300;
    raw.derived_time_window_content_returned = raw.caregiver_can_access_derived_time_window && Boolean((derivedTrace.body || '').trim());
    raw.metrics.derived_view_fetch_ms = derivedTrace.totalLatencyMs ?? null;
    raw.metrics.derived_view_payload_size_bytes = Buffer.byteLength(derivedTrace.body || '', 'utf8');
    if (!raw.derived_time_window_content_returned) {
      throw new Error('Derived time-window content could not be fetched as a non-empty authorized RDF payload');
    }
    raw.metrics.limited_access_total_latency_ms = derivedTrace.totalLatencyMs ?? null;
    raw.metrics.limited_access_initial_challenge_ms = derivedTrace.initialChallengeMs ?? null;
    raw.metrics.limited_access_token_exchange_ms = derivedTrace.tokenExchangeMs ?? null;
    raw.metrics.limited_access_authorized_get_ms = derivedTrace.authorizedGetMs ?? null;

    const queryPromise = registerQueryAndWait(
      scenario,
      opts,
      benchmarkRunId,
      requiredResultWindowMsForScenario(scenario, opts),
    );
    await sleep(500);
    await ingestBoundedDerivedViewAtPanda(
      raw.derived_time_window_url,
      derivedTrace.body || '',
      httpStatuses,
      {
        benchmarkControlToken,
        windowCloseMarkerTimestamp: raw.limited_window_end,
      },
    );

    const queryResult = await queryPromise;

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
    const metrics = timing.metrics || {};
    const serverRegistered = parseNs(timing.query_registered_at_ns);
    const serverFirstAdd = parseNs(timing.first_stream_event_added_at_ns || timing.first_stream_event_at_ns);
    const serverFirstResult = parseNs(timing.first_result_emitted_at_ns);
    const serverSent = parseNs(timing.server_sent_at_ns);
    const queryToResultMs = queryResult.firstResultAt - queryResult.querySendAt;
    const queryToFirstAddMs = nsDiffMs(serverRegistered, serverFirstAdd);
    const serverRegisteredToServerSentMs = nsDiffMs(serverRegistered, serverSent);
    const rspEventCount = metrics.rsp_stream_event_count_after_query_registration ?? 0;
    const rspEventAddTotalMs = metrics.rsp_event_add_total_ms ?? null;
    const derivedViewObservationCount = metrics.derived_view_observation_count ?? null;
    const derivedViewParseMs = metrics.derived_view_parse_ms ?? null;
    const boundedObservationIngestTotalMs = metrics.bounded_observation_ingest_total_ms ?? null;
    const boundedObservationIngestMeanMs = metrics.bounded_observation_ingest_mean_ms ?? null;
    const firstEventTimestampMs = metrics.rsp_first_event_timestamp_ms ?? null;
    const lastEventTimestampMs = metrics.rsp_last_event_timestamp_ms ?? null;

    sequence.rsp_first_event_after_query_registered = timing.first_stream_event_added_at_ns ? isoNow() : undefined;
    sequence.first_any_result_emitted = timing.first_result_emitted_at_ns ? isoNow() : undefined;

    raw.metrics = {
      ...raw.metrics,
      query_registered_to_result_received_ms: queryToResultMs,
      rsp_first_post_registration_event_added_to_result_received_ms: Number.isFinite(queryToFirstAddMs)
        ? Math.max(0, queryToResultMs - queryToFirstAddMs)
        : null,
      rsp_event_add_total_ms: rspEventAddTotalMs,
      rsp_event_add_mean_ms: rspEventCount > 0 && Number.isFinite(rspEventAddTotalMs)
        ? rspEventAddTotalMs / rspEventCount
        : null,
      rsp_first_result_emit_ms: nsDiffMs(serverRegistered, serverFirstResult),
      result_emit_to_client_receive_ms: Number.isFinite(serverRegisteredToServerSentMs)
        ? Math.max(0, queryToResultMs - serverRegisteredToServerSentMs)
        : null,
      rule_evaluation_ms: nsDiffMs(parseNs(timing.rule_eval_started_at_ns), parseNs(timing.rule_eval_finished_at_ns)),
      derived_view_parse_ms: derivedViewParseMs,
      derived_view_observation_count: derivedViewObservationCount,
      bounded_observation_ingest_total_ms: boundedObservationIngestTotalMs,
      bounded_observation_ingest_mean_ms: boundedObservationIngestMeanMs,
    };
    raw.rsp_event_add_count_total = Math.min(rspEventCount, raw.expected_derived_observation_count);
    raw.returned_observation_count = derivedViewObservationCount ?? 0;
    raw.returned_observation_min_timestamp = isoFromNullableTimestampMs(firstEventTimestampMs);
    raw.returned_observation_max_timestamp = isoFromNullableTimestampMs(lastEventTimestampMs);
    raw.returned_observations_within_window = Boolean(
      Number.isFinite(firstEventTimestampMs)
      && Number.isFinite(lastEventTimestampMs)
      && firstEventTimestampMs >= Date.parse(raw.limited_window_start)
      && lastEventTimestampMs < Date.parse(raw.limited_window_end)
      && raw.returned_observation_count === raw.expected_derived_observation_count
    );
    raw.out_of_window_observations_returned = [];
    raw.content_matches_time_window = Boolean(
      raw.returned_observation_count === raw.expected_derived_observation_count
      && raw.returned_observations_within_window === true
      && !Number.isNaN(Date.parse(raw.returned_observation_min_timestamp || ''))
      && !Number.isNaN(Date.parse(raw.returned_observation_max_timestamp || ''))
    );
    raw.validation_warnings.push({
      code: 'window_adjusted_observed_latency_not_meaningful',
      message: `window_adjusted_observed_latency_ms is not recorded for the bounded derived-view processing scenario because the ${raw.expected_derived_observation_count} real observations are ingested faster than wall-clock time.`,
    });

    raw.rsp_result_count = queryResult.resultCount;
    raw.monitoring_result_produced = Boolean(queryResult.message?.aggregation_event);
    raw.anomaly_result_generated = /HEART_RATE_ALERT|alert/i.test(queryResult.message?.aggregation_event || '');
    raw.resource_usage_sample_count = countResourceUsageSamples(raw.resource_usage_log_file);
    raw.critical_path_timeline = buildCriticalPathTimeline(events, queryResult, timing);
    Object.assign(raw, acceptedResultDebugFields(queryResult.acceptedResultEvidence));
    Object.assign(raw, aggregationWindowDebugFields(queryResult.message, 'accepted_result'));
    Object.assign(raw, firstAnyResultDebugFields(queryResult.firstAnyResultEvidence));
    Object.assign(raw, ignoredResultDebugFields(queryResult.lastIgnoredPartialEvidence));

    raw.scenario_passed = Boolean(
      raw.caregiver_requester_used === true
      && raw.full_stream_publicly_readable === false
      && raw.derived_time_window_resource_publicly_readable === false
      && raw.caregiver_can_access_full_stream === false
      && raw.caregiver_can_access_derived_time_window === true
      && raw.fake_replayer_used === false
      && raw.data_source_mode === 'real_fixture_10min'
      && raw.stream_container_reused_for_compatibility === true
      && raw.logical_signal === LIMITED_LOGICAL_SIGNAL
      && raw.expected_property_iri === (scenario.expected_property_iri || DEFAULT_EXPECTED_PROPERTY_IRI)
      && raw.physical_stream_container_url === LIMITED_PHYSICAL_STREAM_CONTAINER_URL
      && raw.source_dataset_path === LIMITED_FIXTURE_SOURCE_DATASET_PATH
      && raw.bounded_fixture_path === LIMITED_FIXTURE_PATH
      && raw.source_observation_count === LIMITED_FIXTURE_SOURCE_OBSERVATION_COUNT
      && raw.bounded_fixture_observation_count === LIMITED_FIXTURE_BOUNDED_OBSERVATION_COUNT
      && raw.bounded_fixture_duration_ms > raw.limited_window_duration_ms
      && raw.source_events_written_count === raw.bounded_fixture_observation_count
      && raw.in_window_events_written_count === raw.expected_derived_observation_count
      && raw.out_of_window_events_written_count === (raw.bounded_fixture_observation_count - raw.expected_derived_observation_count)
      && raw.derived_time_window_content_returned === true
      && raw.full_stream_content_returned_to_caregiver === false
      && raw.returned_observation_count === raw.expected_derived_observation_count
      && raw.returned_observations_within_window === true
      && raw.out_of_window_observations_returned.length === 0
      && raw.content_matches_time_window === true
      && raw.rsp_event_add_count_total === raw.expected_derived_observation_count
      && raw.metrics.derived_view_observation_count === raw.expected_derived_observation_count
      && Number.isFinite(raw.metrics.derived_view_parse_ms)
      && Number.isFinite(raw.metrics.derived_view_fetch_ms)
      && Number.isFinite(raw.metrics.derived_view_payload_size_bytes)
      && Number.isFinite(raw.metrics.bounded_observation_ingest_total_ms)
      && Number.isFinite(raw.metrics.bounded_observation_ingest_mean_ms)
      && Number.isFinite(raw.accepted_result_rsp_window_metadata_span_ms)
      && raw.accepted_result_rsp_window_metadata_span_ms >= raw.limited_window_duration_ms
      && raw.rsp_result_count >= 1
      && raw.monitoring_result_produced === true
      && (raw.expected_anomaly !== true || raw.anomaly_result_generated === true)
    );

    raw.status = 'complete';
    raw.completed_at = isoNow();
    raw.log_markers_found = findLogMarkers(panda.logFile, scenario.required_log_markers || []);
    raw.output_check = {
      passed: raw.scenario_passed,
      details: raw.scenario_passed ? {} : {
        reason: 'Limited caregiver time-window processing validation failed.',
      },
    };
    attachMetricDefinitions(raw);
    writeJson(rawPath, raw);
    if (!raw.output_check.passed) {
      writeJson(failurePath, raw);
      if (!opts.continueOnFailure) throw new Error('Limited caregiver time-window processing validation failed');
    }
    return raw;
  } catch (error) {
    raw.status = 'failed';
    raw.completed_at = isoNow();
    raw.error = error?.stack || String(error);
    raw.resource_usage_sample_count = countResourceUsageSamples(raw.resource_usage_log_file);
    attachMetricDefinitions(raw);
    raw.output_check = { passed: false, details: { error: String(error?.message || error) } };
    writeJson(failurePath, raw);
    writeJson(rawPath, raw);
    if (!opts.continueOnFailure) throw error;
    return raw;
  } finally {
    stopChild(panda?.child);
    stopChild(umaProcess);
    if (opts.force) {
      killPortsIfForced(true, [3000, 4000, 8080]);
    }
  }
}

async function runLimitedCaregiverTimeWindowAccessScenario(scenario, opts, runRoot, runId, phase) {
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
    expected_decision: scenario.expected_decision,
    scenario_file_path: scenario.__scenario_file || null,
    run_id: runId,
    phase,
    mode: opts.mode,
    deployment_mode: 'single_machine',
    query_window_seconds: opts.queryWindow,
    replayer_duration_seconds: opts.replayerDuration,
    query_registration_delay_seconds: opts.queryRegistrationDelay,
    started_at: isoNow(),
    completed_at: null,
    status: 'running',
    validation_warnings: [],
    sequence,
    metrics: {},
    http_statuses: httpStatuses,
    log_markers_found: [],
    output_check: { passed: false, details: {} },
    caregiver_actor_webid: scenario.caregiver_actor_webid,
    caregiver_requester_used: false,
    source_stream_url: scenario.target_css_resources.stream_container_url,
    derived_time_window_url: scenario.target_css_resources.derived_time_window_url,
    filter_resource_url: scenario.target_css_resources.filter_resource_url,
    limited_window_start: scenario.limited_window.start,
    limited_window_end: scenario.limited_window.end,
    limited_window_duration_ms: scenario.limited_window.duration_ms,
    full_stream_publicly_readable: null,
    derived_time_window_resource_publicly_readable: null,
    caregiver_can_access_full_stream: false,
    caregiver_can_access_derived_time_window: false,
    fake_replayer_used: false,
    data_source_mode: 'real_fixture_10min',
    source_dataset_path: LIMITED_FIXTURE_SOURCE_DATASET_PATH,
    bounded_fixture_path: LIMITED_FIXTURE_PATH,
    source_observation_count: LIMITED_FIXTURE_SOURCE_OBSERVATION_COUNT,
    bounded_fixture_observation_count: 0,
    bounded_fixture_window_start: LIMITED_FIXTURE_WINDOW_START,
    bounded_fixture_window_end: LIMITED_FIXTURE_WINDOW_END,
    bounded_fixture_duration_ms: LIMITED_FIXTURE_WINDOW_DURATION_MS,
    stream_container_reused_for_compatibility: true,
    logical_signal: LIMITED_LOGICAL_SIGNAL,
    expected_property_iri: scenario.expected_property_iri || DEFAULT_EXPECTED_PROPERTY_IRI,
    physical_stream_container_url: LIMITED_PHYSICAL_STREAM_CONTAINER_URL,
    source_events_written_count: 0,
    in_window_events_written_count: 0,
    out_of_window_events_written_count: 0,
    expected_derived_observation_count: LIMITED_FIXTURE_IN_WINDOW_OBSERVATION_COUNT,
    derived_time_window_content_returned: false,
    full_stream_content_returned_to_caregiver: false,
    returned_observation_count: 0,
    returned_observation_min_timestamp: null,
    returned_observation_max_timestamp: null,
    returned_observations_within_window: false,
    content_matches_time_window: false,
    scenario_passed: false,
    resource_usage_enabled: opts.collectResourceUsage,
    resource_usage_log_file: null,
    resource_usage_sample_count: 0,
    benchmark_control_enabled: false,
    benchmark_control_token_configured: false,
  };
  let panda;
  let umaProcess;
  const events = {};
  const markEvent = (event, notes = '') => {
    events[event] = { t: performance.now(), timestamp: isoNow(), notes };
  };
  try {
    killPortsIfForced(opts.force, [3000, 4000, 8080]);
    await sleep(opts.force ? 2000 : 0);

    markEvent('css_uma_start_start');
    const uma = await startUma(opts, runRoot, runId);
    umaProcess = uma.child;
    markEvent('css_uma_ready');
    sequence.css_uma_started = isoNow();
    raw.metrics.css_uma_startup_ms = uma.ms;

    markEvent('container_creation_start');
    const setup = await createContainersAndPolicies(scenario, uma.cssStatePath, httpStatuses);
    markEvent('containers_created');
    sequence.containers_created = isoNow();
    markEvent('meta_policy_write_start');
    markEvent('meta_policies_written');
    sequence.meta_policies_written = isoNow();
    raw.metrics.container_creation_ms = setup.containerCreationMs;
    raw.metrics.meta_policy_write_ms = setup.metaPolicyWriteMs;

    markEvent('panda_start_start');
    panda = await startPanda(opts, runRoot, scenario.scenario_id, runId, phase, {}, scenario.expected_property_iri || DEFAULT_EXPECTED_PROPERTY_IRI);
    markEvent('panda_ready');
    sequence.panda_started = isoNow();
    raw.metrics.panda_startup_ms = panda.ms;
    raw.resource_usage_log_file = panda.resourceUsageLogFile;

    const fixture = loadRealFixtureObservations(
      LIMITED_FIXTURE_PATH,
      LIMITED_FIXTURE_WINDOW_START,
      LIMITED_FIXTURE_WINDOW_END,
    );
    raw.bounded_fixture_observation_count = fixture.boundedFixtureObservationCount;
    raw.expected_derived_observation_count = fixture.boundedFixtureObservationCount;

    markEvent('replayer_start');
    const preload = await postObservationFixture(
      fixture,
      raw.source_stream_url,
      httpStatuses,
      'limited_replay',
      raw.limited_window_start,
      raw.limited_window_end,
    );
    markEvent('replayer_completed');
    sequence.replayer_started = isoNow();
    sequence.replayer_completed = isoNow();
    raw.source_events_written_count = preload.sourceEventsWrittenCount;
    raw.in_window_events_written_count = preload.inWindowEventsWrittenCount;
    raw.out_of_window_events_written_count = preload.outOfWindowEventsWrittenCount;
    raw.replayer_process = {
      command: 'real_fixture_10min_nt_post',
      requested_duration_seconds: null,
      process_started_at: sequence.replayer_started,
      process_exit_at: sequence.replayer_completed,
      exit_code: 0,
      exit_signal: null,
      actual_process_runtime_ms: preload.preloadMs,
      observations_posted: preload.sourceEventsWrittenCount,
      source_dataset_path: LIMITED_FIXTURE_SOURCE_DATASET_PATH,
      bounded_fixture_path: LIMITED_FIXTURE_PATH,
    };

    const publicFullResponse = await fetch(raw.source_stream_url, {
      headers: { Accept: 'text/turtle' },
    });
    httpStatuses.push({ phase: 'full_stream_public_probe', status: publicFullResponse.status, url: raw.source_stream_url });
    raw.full_stream_publicly_readable = publicFullResponse.ok;

    const publicDerivedResponse = await fetch(raw.derived_time_window_url, {
      headers: { Accept: 'text/turtle' },
    });
    httpStatuses.push({
      phase: 'derived_time_window_public_probe',
      status: publicDerivedResponse.status,
      url: raw.derived_time_window_url,
      www_authenticate: publicDerivedResponse.headers.get('WWW-Authenticate') || undefined,
    });
    raw.derived_time_window_resource_publicly_readable = publicDerivedResponse.ok;

    const denialTrace = await fetchWithClaimUma(
      raw.source_stream_url,
      raw.caregiver_actor_webid,
      httpStatuses,
      'caregiver_full_stream',
    );
    raw.caregiver_requester_used = raw.caregiver_requester_used || denialTrace.usedClaimToken;
    raw.caregiver_can_access_full_stream = denialTrace.finalStatus >= 200 && denialTrace.finalStatus < 300;
    raw.full_stream_content_returned_to_caregiver = raw.caregiver_can_access_full_stream && Boolean(denialTrace.body.trim());
    raw.metrics.full_stream_denial_latency_ms = raw.caregiver_can_access_full_stream ? null : denialTrace.totalLatencyMs;

    const derivedFetchStartedAt = performance.now();
    const derivedResult = await waitForDerivedWindowContent(
      raw.derived_time_window_url,
      raw.caregiver_actor_webid,
      raw.limited_window_start,
      raw.limited_window_end,
      httpStatuses,
    );
    raw.metrics.derived_time_window_fetch_ms = performance.now() - derivedFetchStartedAt;
    const derivedTrace = derivedResult.fetchTrace || {};
    raw.caregiver_requester_used = raw.caregiver_requester_used || Boolean(derivedTrace.usedClaimToken);
    raw.caregiver_can_access_derived_time_window = derivedTrace.finalStatus >= 200 && derivedTrace.finalStatus < 300;
    raw.derived_time_window_content_returned = raw.caregiver_can_access_derived_time_window && Boolean((derivedTrace.body || '').trim());
    raw.metrics.limited_access_total_latency_ms = derivedTrace.totalLatencyMs ?? null;
    raw.metrics.limited_access_initial_challenge_ms = derivedTrace.initialChallengeMs ?? null;
    raw.metrics.limited_access_token_exchange_ms = derivedTrace.tokenExchangeMs ?? null;
    raw.metrics.limited_access_authorized_get_ms = derivedTrace.authorizedGetMs ?? null;

    let parsed = derivedResult.parsed;
    if (!parsed && raw.derived_time_window_content_returned && derivedTrace.body) {
      parsed = parseDerivedObservationPayload(derivedTrace.body, raw.limited_window_start, raw.limited_window_end);
    }
    raw.metrics.derived_time_window_parse_ms = parsed?.parseMs ?? null;
    raw.metrics.derived_time_window_validation_ms = parsed?.validationMs ?? null;

    if (parsed) {
      raw.returned_observation_count = parsed.observationCount;
      raw.returned_observation_min_timestamp = parsed.minTimestamp;
      raw.returned_observation_max_timestamp = parsed.maxTimestamp;
      raw.returned_observations_within_window = parsed.returnedObservationsWithinWindow;
      raw.content_matches_time_window = Boolean(
        parsed.observationCount > 0
        && parsed.missingTimestampCount === 0
        && !parsed.parseFailure
        && parsed.returnedObservationsWithinWindow
      );
      if (parsed.missingTimestampCount > 0) {
        raw.validation_warnings.push({
          code: 'returned_observation_missing_timestamp',
          message: `${parsed.missingTimestampCount} returned observation subject(s) did not have saref:hasTimestamp.`,
        });
      }
      if (parsed.parseFailure) {
        raw.validation_warnings.push({
          code: 'returned_timestamp_parse_failure',
          message: 'At least one returned observation timestamp could not be parsed.',
        });
      }
    } else {
      raw.validation_warnings.push({
        code: 'derived_time_window_parse_missing',
        message: 'Derived time-window content could not be parsed into a validated RDF observation set.',
      });
    }

    raw.scenario_passed = Boolean(
      raw.caregiver_requester_used === true
      && raw.full_stream_publicly_readable === false
      && raw.derived_time_window_resource_publicly_readable === false
      && raw.caregiver_can_access_full_stream === false
      && raw.caregiver_can_access_derived_time_window === true
      && raw.fake_replayer_used === false
      && raw.data_source_mode === 'real_fixture_10min'
      && raw.stream_container_reused_for_compatibility === true
      && raw.logical_signal === LIMITED_LOGICAL_SIGNAL
      && raw.expected_property_iri === (scenario.expected_property_iri || DEFAULT_EXPECTED_PROPERTY_IRI)
      && raw.physical_stream_container_url === LIMITED_PHYSICAL_STREAM_CONTAINER_URL
      && raw.source_dataset_path === LIMITED_FIXTURE_SOURCE_DATASET_PATH
      && raw.bounded_fixture_path === LIMITED_FIXTURE_PATH
      && raw.source_observation_count === LIMITED_FIXTURE_SOURCE_OBSERVATION_COUNT
      && raw.bounded_fixture_observation_count === LIMITED_FIXTURE_BOUNDED_OBSERVATION_COUNT
      && raw.bounded_fixture_duration_ms > raw.limited_window_duration_ms
      && raw.source_events_written_count === raw.bounded_fixture_observation_count
      && raw.in_window_events_written_count === raw.expected_derived_observation_count
      && raw.out_of_window_events_written_count === (raw.bounded_fixture_observation_count - raw.expected_derived_observation_count)
      && raw.derived_time_window_content_returned === true
      && raw.full_stream_content_returned_to_caregiver === false
      && raw.returned_observation_count > 0
      && raw.returned_observation_count === raw.expected_derived_observation_count
      && raw.returned_observations_within_window === true
      && raw.content_matches_time_window === true
    );

    raw.status = 'complete';
    raw.completed_at = isoNow();
    raw.output_check = {
      passed: raw.scenario_passed,
      details: raw.scenario_passed ? {} : {
        reason: 'Limited caregiver time-window access validation failed.',
      },
    };
    raw.resource_usage_sample_count = countResourceUsageSamples(raw.resource_usage_log_file);
    attachMetricDefinitions(raw);
    writeJson(rawPath, raw);
    if (!raw.output_check.passed) {
      writeJson(failurePath, raw);
      if (!opts.continueOnFailure) throw new Error('Limited caregiver time-window access validation failed');
    }
    return raw;
  } catch (error) {
    raw.status = 'failed';
    raw.completed_at = isoNow();
    raw.error = error?.stack || String(error);
    raw.resource_usage_sample_count = countResourceUsageSamples(raw.resource_usage_log_file);
    attachMetricDefinitions(raw);
    raw.output_check = { passed: false, details: { error: String(error?.message || error) } };
    writeJson(failurePath, raw);
    writeJson(rawPath, raw);
    if (!opts.continueOnFailure) throw error;
    return raw;
  } finally {
    stopChild(panda?.child);
    stopChild(umaProcess);
    if (opts.force) {
      killPortsIfForced(true, [3000, 4000, 8080]);
    }
  }
}

async function runOneScenario(scenario, opts, runRoot, runId, phase) {
  if (isLimitedCaregiverProcessingScenario(scenario)) {
    return runLimitedCaregiverTimeWindowProcessingScenario(scenario, opts, runRoot, runId, phase);
  }
  if (isLimitedCaregiverScenario(scenario)) {
    return runLimitedCaregiverTimeWindowAccessScenario(scenario, opts, runRoot, runId, phase);
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
    benchmark_control_enabled: false,
    benchmark_control_token_configured: false,
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
    const pandaPromise = startPanda(opts, runRoot, scenario.scenario_id, runId, phase);
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
