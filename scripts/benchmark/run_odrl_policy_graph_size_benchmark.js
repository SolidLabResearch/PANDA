#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Parser, Store, DataFactory } = require('n3');
const {
  BENCHMARK_NAME,
  POLICY_COUNTS,
  MATCHING_POLICY_UID,
  DEFAULT_OWNER_WEBID,
  DEFAULT_REQUESTER_WEBID,
  DEFAULT_TARGET,
  DEFAULT_ACTION,
  generatedPolicyDirectory,
  generatedPolicyFilePath,
  writeGeneratedPolicySet,
  countMatchingBenchmarkPolicies,
} = require('./odrl_policy_graph_size_shared');
const {
  siblingDefaults,
  resolveRepoPath,
  ensureRepoExists,
} = require('./workspace_paths');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ODRL_NS = 'http://www.w3.org/ns/odrl/2/';
const ODRL_AGREEMENT = `${ODRL_NS}Agreement`;
const ODRL_SET = `${ODRL_NS}Set`;
const ODRL_UID = `${ODRL_NS}uid`;
const ODRL_PERMISSION = `${ODRL_NS}permission`;
const ODRL_TARGET = `${ODRL_NS}target`;
const ODRL_ASSIGNEE = `${ODRL_NS}assignee`;
const ODRL_ACTION = `${ODRL_NS}action`;
const BENCHMARK_UID_PREFIX = 'urn:panda:benchmark:policy:';

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

function commandForDisplay(command, args) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
}

function spawnLogged(command, args, options, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    detached: true,
    shell: false,
  });
  child.stdout.on('data', (chunk) => out.write(chunk));
  child.stderr.on('data', (chunk) => out.write(chunk));
  child.on('exit', (code, signal) => out.write(`[process_exit] code=${code} signal=${signal}\n`));
  child.displayCommand = commandForDisplay(command, args);
  child.logFile = logFile;
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

async function waitForChildExit(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs),
  ]);
}

function formatFetchError(label, method, url, detail) {
  return `[${label}] ${method} ${url} ${detail}`;
}

async function fetchWithContext(label, url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    throw new Error(formatFetchError(label, method, url, `failed: ${reason}`));
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      formatFetchError(
        label,
        method,
        url,
        `returned ${response.status} ${response.statusText}:${body ? `\n${body}` : ''}`
      )
    );
  }
  return response;
}

function parseArgs(argv) {
  const out = {
    counts: POLICY_COUNTS.slice(),
    warmupIterations: Number(env('WARMUP_ITERATIONS', '2')),
    iterations: Number(env('ITERATIONS', '10')),
    interIterationDelayMs: Number(env('INTER_ITERATION_DELAY_MS', '150')),
    outputDir: env(
      'OUTPUT_DIR',
      path.join(process.cwd(), 'benchmark-results', `${BENCHMARK_NAME}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    ),
    ownerWebId: env('PANDA_UMA_POLICY_OWNER_WEBID', DEFAULT_OWNER_WEBID),
    requesterWebId: env('PANDA_UMA_CLAIM_TOKEN', DEFAULT_REQUESTER_WEBID),
    requestTarget: env('PANDA_UMA_RESOURCE', DEFAULT_TARGET),
    requestAction: env('PANDA_ODRL_BENCH_ACTION', DEFAULT_ACTION),
    claimTokenFormat: env('PANDA_UMA_CLAIM_TOKEN_FORMAT', 'urn:solidlab:uma:claims:formats:webid'),
    asBase: env('PANDA_UMA_AUTH_SERVER', 'http://localhost:4000/uma'),
    policyEndpoint: env('PANDA_UMA_POLICY_ENDPOINT', 'http://localhost:4000/uma/policies'),
    allowTypeE: env('PANDA_ODRL_BENCH_ALLOW_TYPE_E', 'true').toLowerCase() !== 'false',
    managedStack: env('PANDA_ODRL_BENCH_MANAGED_STACK', 'true').toLowerCase() !== 'false',
    readinessTimeoutMs: Number(env('PANDA_ODRL_BENCH_READINESS_TIMEOUT_MS', '120000')),
    umaStartCommand: env('PANDA_ODRL_BENCH_UMA_START_COMMAND', 'corepack'),
    umaStartArgs: env('PANDA_ODRL_BENCH_UMA_START_ARGS', 'yarn start:odrl').split(/\s+/).filter(Boolean),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--counts' && next) {
      out.counts = next.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v >= 1);
    }
    if (key === '--warmup' && next) out.warmupIterations = Number(next);
    if (key === '--runs' && next) out.iterations = Number(next);
    if (key === '--delay-ms' && next) out.interIterationDelayMs = Number(next);
    if (key === '--output-dir' && next) out.outputDir = path.resolve(next);
    if (key === '--requester' && next) out.requesterWebId = next;
    if (key === '--target' && next) out.requestTarget = next;
    if (key === '--owner' && next) out.ownerWebId = next;
    if (key === '--policy-counts' && next) {
      out.counts = next.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v >= 1);
    }
    if (key === '--no-managed-stack') out.managedStack = false;
    if (key === '--managed-stack') out.managedStack = true;
  }

  if (!out.counts.length) throw new Error('No benchmark policy counts configured.');
  if (out.iterations < 1) throw new Error('ITERATIONS must be >= 1.');
  if (out.warmupIterations < 0) throw new Error('WARMUP_ITERATIONS must be >= 0.');
  return out;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((acc, value) => acc + ((value - avg) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function summarizeMetric(values) {
  if (!values.length) {
    return {
      mean: null,
      stddev: null,
      median: null,
      p95: null,
      min: null,
      max: null,
    };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    mean: Number(mean(sorted).toFixed(3)),
    stddev: Number(stddev(sorted).toFixed(3)),
    median: Number(percentile(sorted, 50).toFixed(3)),
    p95: Number(percentile(sorted, 95).toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

function parseAuthenticateHeader(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader || !/^UMA\s+/i.test(wwwAuthenticateHeader)) {
    throw new Error(`Expected UMA challenge, got: ${wwwAuthenticateHeader || '<empty>'}`);
  }
  const headerWithoutScheme = wwwAuthenticateHeader.replace(/^UMA\s+/i, '');
  const params = Object.fromEntries(
    headerWithoutScheme.split(/\s*,\s*/).map((param) => {
      const separatorIndex = param.indexOf('=');
      if (separatorIndex < 0) return [ param.trim(), '' ];
      const key = param.slice(0, separatorIndex).trim();
      const value = param.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '');
      return [ key, value ];
    })
  );
  if (!params.ticket || !params.as_uri) {
    throw new Error(`Invalid UMA WWW-Authenticate header: ${wwwAuthenticateHeader}`);
  }
  return {
    ticket: params.ticket,
    tokenEndpoint: new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString(),
  };
}

function policyHeaders(ownerWebId) {
  return {
    authorization: `WebID ${encodeURIComponent(ownerWebId)}`,
    accept: 'text/turtle',
  };
}

async function getPoliciesTurtle(config) {
  const response = await fetchWithContext('GET policy inventory', config.policyEndpoint, {
    method: 'GET',
    headers: policyHeaders(config.ownerWebId),
  });
  return response.text();
}

function parseStoreFromTurtle(turtle, baseIRI = 'http://localhost:3000/') {
  if (!turtle || !turtle.trim()) return new Store();
  return new Store(new Parser({ baseIRI }).parse(turtle));
}

function parseActionName(actionIri) {
  if (!actionIri) return '';
  if (actionIri.startsWith(ODRL_NS)) return actionIri.slice(ODRL_NS.length);
  return actionIri;
}

function extractPolicyDescriptors(store) {
  const namedNode = DataFactory.namedNode;
  const descriptors = [];
  const policySubjects = new Set([
    ...store.getSubjects(namedNode(RDF_TYPE), namedNode(ODRL_AGREEMENT), null).map((term) => term.value),
    ...store.getSubjects(namedNode(RDF_TYPE), namedNode(ODRL_SET), null).map((term) => term.value),
  ]);

  for (const policySubject of policySubjects) {
    const uidObjects = store.getObjects(namedNode(policySubject), namedNode(ODRL_UID), null);
    if (!uidObjects.length) continue;
    const uid = uidObjects[0].value;
    const permissionNodes = store.getObjects(
      namedNode(policySubject),
      namedNode(ODRL_PERMISSION),
      null
    ).map((term) => term.value);
    const permissions = permissionNodes.map((permissionNode) => {
      const target = store.getObjects(namedNode(permissionNode), namedNode(ODRL_TARGET), null)[0]?.value || null;
      const assignee = store.getObjects(namedNode(permissionNode), namedNode(ODRL_ASSIGNEE), null)[0]?.value || null;
      const action = parseActionName(
        store.getObjects(namedNode(permissionNode), namedNode(ODRL_ACTION), null)[0]?.value || ''
      );
      return { permissionNode, target, assignee, action };
    });
    descriptors.push({
      subject: policySubject,
      uid,
      permissions,
      isBenchmark: uid.startsWith(BENCHMARK_UID_PREFIX),
    });
  }
  return descriptors;
}

function countMatchingLoadedBenchmarkPolicies(descriptors, request) {
  return descriptors
    .filter((descriptor) => descriptor.isBenchmark)
    .filter((descriptor) => descriptor.permissions.some((permission) => (
      permission.target === request.target &&
      permission.assignee === request.requester &&
      permission.action === request.action
    ))).length;
}

function collectBenchmarkPolicyUids(descriptors) {
  return descriptors.filter((descriptor) => descriptor.isBenchmark).map((descriptor) => descriptor.uid);
}

async function deletePolicyByUid(config, policyUid) {
  const url = `${config.policyEndpoint}/${encodeURIComponent(policyUid)}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'DELETE',
      headers: policyHeaders(config.ownerWebId),
    });
  } catch (error) {
    throw new Error(formatFetchError('DELETE benchmark policy by UID', 'DELETE', url, `failed: ${error.message}`));
  }
  if (!(response.status === 204 || response.status === 404)) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to delete policy ${policyUid} (${response.status}): ${body}`);
  }
  return response.status;
}

async function cleanupBenchmarkPolicies(config) {
  const turtle = await getPoliciesTurtle(config);
  const descriptors = extractPolicyDescriptors(parseStoreFromTurtle(turtle));
  const benchmarkUids = collectBenchmarkPolicyUids(descriptors);
  for (const uid of benchmarkUids) {
    await deletePolicyByUid(config, uid);
  }
  return benchmarkUids.length;
}

async function postPolicyTurtle(config, turtleBody) {
  let response;
  try {
    response = await fetch(config.policyEndpoint, {
      method: 'POST',
      headers: {
        ...policyHeaders(config.ownerWebId),
        'content-type': 'text/turtle',
      },
      body: turtleBody,
    });
  } catch (error) {
    throw new Error(
      formatFetchError('POST generated ODRL policies', 'POST', config.policyEndpoint, `failed: ${error.message}`)
    );
  }
  const body = await response.text().catch(() => '');
  return { status: response.status, body };
}

async function ensureExistingPolicy0Loaded(config) {
  const post = await postPolicyTurtle(config, config.existingPolicyBody);
  if (!(post.status === 201 || post.status === 409)) {
    throw new Error(`Failed loading existing policy0.ttl via API (${post.status}): ${post.body}`);
  }
  return post.status;
}

async function seedBenchmarkPolicies(config, generatedPolicyFile) {
  const turtle = fs.readFileSync(generatedPolicyFile, 'utf8');
  const post = await postPolicyTurtle(config, turtle);
  if (!(post.status === 201 || post.status === 409)) {
    throw new Error(`Failed loading generated benchmark policies (${post.status}): ${post.body}`);
  }
  return { status: post.status, body: post.body };
}

async function readPolicyInventory(config, requestedBenchmarkPolicyCount) {
  const turtle = await getPoliciesTurtle(config);
  const store = parseStoreFromTurtle(turtle);
  const descriptors = extractPolicyDescriptors(store);
  const benchmarkPolicyCount = descriptors.filter((descriptor) => descriptor.isBenchmark).length;
  const existingPolicyCount = descriptors.filter((descriptor) => !descriptor.isBenchmark).length;
  const totalLoadedPolicyCount = descriptors.length;
  const policyQuadCount = store.size;
  const matchingBenchmarkPoliciesLoaded = countMatchingLoadedBenchmarkPolicies(descriptors, {
    requester: config.requesterWebId,
    target: config.requestTarget,
    action: config.requestAction,
  });
  return {
    requested_benchmark_policy_count: requestedBenchmarkPolicyCount,
    benchmark_policy_count: benchmarkPolicyCount,
    existing_policy_count: existingPolicyCount,
    total_loaded_policy_count: totalLoadedPolicyCount,
    policy_quad_count: policyQuadCount,
    matching_benchmark_policies_loaded: matchingBenchmarkPoliciesLoaded,
  };
}

async function runUmaAccessIteration(config, phase, iteration, benchmarkPolicyCount, policyInventory) {
  const row = {
    benchmark_name: BENCHMARK_NAME,
    phase,
    iteration,
    benchmark_policy_count: benchmarkPolicyCount,
    existing_policy_count: policyInventory.existing_policy_count,
    total_loaded_policy_count: policyInventory.total_loaded_policy_count,
    policy_quad_count: policyInventory.policy_quad_count,
    matching_benchmark_policies_loaded: policyInventory.matching_benchmark_policies_loaded,
    requester_webid: config.requesterWebId,
    target: config.requestTarget,
    action: config.requestAction,
    challenge_status: null,
    token_status: null,
    authorized_status: null,
    uma_initial_challenge_ms: 0,
    uma_token_exchange_ms: 0,
    authorized_get_ms: 0,
    total_first_access_ms: 0,
    odrl_evaluation_ms: null,
    outcome: 'failed',
    status: 'failed',
    final_protected_get_succeeded: false,
    generated_matching_policy_count: 1,
    started_at: new Date().toISOString(),
    error: null,
    observation_checks: {
      expected: false,
      passed: true,
      note: 'This benchmark measures UMA first-access latency only; no stream-observation assertions apply.',
    },
    requires_unrelated_alert_assertions: false,
  };

  const start = nowMs();
  try {
    const challengeStart = nowMs();
    let challengeResponse;
    try {
      challengeResponse = await fetch(config.requestTarget, { method: 'GET' });
    } catch (error) {
      throw new Error(
        formatFetchError('Protected resource UMA challenge request', 'GET', config.requestTarget, `failed: ${error.message}`)
      );
    }
    row.uma_initial_challenge_ms = Number((nowMs() - challengeStart).toFixed(3));
    row.challenge_status = challengeResponse.status;

    const challenge = parseAuthenticateHeader(challengeResponse.headers.get('WWW-Authenticate') || '');

    const tokenStart = nowMs();
    let tokenResponse;
    try {
      tokenResponse = await fetch(challenge.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
          ticket: challenge.ticket,
          claim_token: encodeURIComponent(config.requesterWebId),
          claim_token_format: config.claimTokenFormat,
        }),
      });
    } catch (error) {
      throw new Error(
        formatFetchError('UMA token exchange', 'POST', challenge.tokenEndpoint, `failed: ${error.message}`)
      );
    }
    row.uma_token_exchange_ms = Number((nowMs() - tokenStart).toFixed(3));
    row.token_status = tokenResponse.status;
    const tokenBody = await tokenResponse.text();
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed (${tokenResponse.status}): ${tokenBody}`);
    }
    const tokenJson = JSON.parse(tokenBody);
    if (!tokenJson.access_token) {
      throw new Error('Token exchange response is missing access_token.');
    }

    const authorizedStart = nowMs();
    let authorizedResponse;
    try {
      authorizedResponse = await fetch(config.requestTarget, {
        method: 'GET',
        headers: { Authorization: `${tokenJson.token_type || 'Bearer'} ${tokenJson.access_token}` },
      });
    } catch (error) {
      throw new Error(
        formatFetchError('Authorized protected resource GET', 'GET', config.requestTarget, `failed: ${error.message}`)
      );
    }
    row.authorized_get_ms = Number((nowMs() - authorizedStart).toFixed(3));
    row.authorized_status = authorizedResponse.status;
    row.final_protected_get_succeeded = authorizedResponse.status === 200;
    if (authorizedResponse.status !== 200) {
      const body = await authorizedResponse.text().catch(() => '');
      throw new Error(`Authorized GET failed (${authorizedResponse.status}): ${body}`);
    }

    row.total_first_access_ms = Number((nowMs() - start).toFixed(3));
    row.outcome = 'authorized';
    row.status = 'authorized';
  } catch (error) {
    row.total_first_access_ms = Number((nowMs() - start).toFixed(3));
    row.error = error.message;
  }
  return row;
}

async function runReadinessProbe(config, benchmarkPolicyCount, timeoutMs = 30000, retryDelayMs = 500) {
  const started = nowMs();
  const maxAttempts = Math.max(1, Math.floor(timeoutMs / Math.max(100, retryDelayMs)));
  let attempt = 0;

  while (attempt < maxAttempts && nowMs() - started < timeoutMs) {
    attempt += 1;
    const attemptElapsedMs = Number((nowMs() - started).toFixed(3));
    console.log(`[benchmark:${BENCHMARK_NAME}] readiness probe attempt ${attempt} (elapsed ${attemptElapsedMs}ms) for policy count ${benchmarkPolicyCount}`);

    try {
      // Step 1: Check if target resource is public
      console.log(`[benchmark:${BENCHMARK_NAME}]   → unauthenticated GET ${config.requestTarget}`);
      let publicCheckResponse;
      try {
        publicCheckResponse = await fetch(config.requestTarget, { method: 'GET' });
      } catch (error) {
        throw new Error(
          formatFetchError('Readiness: unauthenticated GET', 'GET', config.requestTarget, `failed: ${error.message}`)
        );
      }

      if (publicCheckResponse.status === 200) {
        throw new Error('Target resource is public; benchmark invalid.');
      }

      if (publicCheckResponse.status !== 401) {
        const body = await publicCheckResponse.text().catch(() => '');
        throw new Error(`Expected 401 challenge from unauthenticated GET, got ${publicCheckResponse.status}: ${body}`);
      }

      // Step 2: Parse UMA challenge
      console.log(`[benchmark:${BENCHMARK_NAME}]   → got UMA challenge (401)`);
      const challenge = parseAuthenticateHeader(publicCheckResponse.headers.get('WWW-Authenticate') || '');

      // Step 3: Token exchange
      console.log(`[benchmark:${BENCHMARK_NAME}]   → exchanging ticket for token`);
      let tokenResponse;
      try {
        tokenResponse = await fetch(challenge.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
            ticket: challenge.ticket,
            claim_token: encodeURIComponent(config.requesterWebId),
            claim_token_format: config.claimTokenFormat,
          }),
        });
      } catch (error) {
        throw new Error(
          formatFetchError('Readiness: token exchange', 'POST', challenge.tokenEndpoint, `failed: ${error.message}`)
        );
      }

      if (!tokenResponse.ok) {
        const body = await tokenResponse.text().catch(() => '');
        throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`);
      }

      const tokenBody = await tokenResponse.text();
      const tokenJson = JSON.parse(tokenBody);
      if (!tokenJson.access_token) {
        throw new Error('Token exchange response is missing access_token.');
      }

      // Step 4: Authorized GET
      console.log(`[benchmark:${BENCHMARK_NAME}]   → authorized GET with token`);
      let authorizedResponse;
      try {
        authorizedResponse = await fetch(config.requestTarget, {
          method: 'GET',
          headers: { Authorization: `${tokenJson.token_type || 'Bearer'} ${tokenJson.access_token}` },
        });
      } catch (error) {
        throw new Error(
          formatFetchError('Readiness: authorized GET', 'GET', config.requestTarget, `failed: ${error.message}`)
        );
      }

      if (authorizedResponse.status === 200) {
        console.log(`[benchmark:${BENCHMARK_NAME}] target resource is ready (authorized GET returned 200)`);
        return; // Success
      }

      if (authorizedResponse.status === 404) {
        const body = await authorizedResponse.text().catch(() => '');
        console.log(`[benchmark:${BENCHMARK_NAME}]   ⚠ target not available yet (authorized GET returned 404). Retrying...`);
        await sleep(retryDelayMs);
        continue; // Retry
      }

      // Other error status
      const body = await authorizedResponse.text().catch(() => '');
      throw new Error(`Authorized GET failed (${authorizedResponse.status}): ${body}`);
    } catch (error) {
      // Log the error and decide whether to retry or fail
      if (error.message.includes('target not available yet')) {
        // Already logged as retryable, continue loop
        continue;
      }
      // Other errors: check if we should retry or fail
      if (error.message.includes('404')) {
        // Treat 404 as retryable
        console.log(`[benchmark:${BENCHMARK_NAME}]   ⚠ ${error.message}. Retrying...`);
        await sleep(retryDelayMs);
        continue;
      }
      // Non-404 errors are fatal
      throw error;
    }
  }

  // Timeout without success
  throw new Error(`Protected target resource is not available after readiness timeout (${timeoutMs}ms).`);
}

function aggregateLevelRows(rows) {
  const measured = rows.filter((row) => row.phase === 'measured');
  const metricValues = (metricName) => measured
    .map((row) => row[metricName])
    .filter((value) => Number.isFinite(value) && value >= 0);

  return {
    run_count: measured.length,
    authorized_runs: measured.filter((row) => row.outcome === 'authorized').length,
    failed_runs: measured.filter((row) => row.outcome !== 'authorized').length,
    metrics: {
      uma_initial_challenge_ms: summarizeMetric(metricValues('uma_initial_challenge_ms')),
      uma_token_exchange_ms: summarizeMetric(metricValues('uma_token_exchange_ms')),
      authorized_get_ms: summarizeMetric(metricValues('authorized_get_ms')),
      total_first_access_ms: summarizeMetric(metricValues('total_first_access_ms')),
      odrl_evaluation_ms: summarizeMetric(metricValues('odrl_evaluation_ms')),
    },
  };
}

function ensureGeneratedPolicySets(config, repoRoot) {
  const generated = [];
  for (const benchmarkPolicyCount of config.counts) {
    const result = writeGeneratedPolicySet({
      repoRoot,
      benchmarkPolicyCount,
      requesterWebId: config.requesterWebId,
      target: config.requestTarget,
      action: config.requestAction,
      ownerWebId: config.ownerWebId,
      allowTypeE: config.allowTypeE,
    });
    const matchingCount = countMatchingBenchmarkPolicies(result.policies, {
      requester: config.requesterWebId,
      target: config.requestTarget,
      action: config.requestAction,
    });
    if (matchingCount !== 1) {
      throw new Error(
        `Generated policies for count=${benchmarkPolicyCount} failed matching validation: expected 1, got ${matchingCount}`
      );
    }
    generated.push({
      benchmark_policy_count: benchmarkPolicyCount,
      generated_file: generatedPolicyFilePath(repoRoot, benchmarkPolicyCount),
      generated_matching_policy_count: matchingCount,
    });
  }
  return generated;
}

async function verifyUmaEndpointsReachable(config) {
  const umaDiscoveryUrl = `${config.asBase.replace(/\/$/, '')}/.well-known/uma2-configuration`;
  const cssBaseUrl = 'http://localhost:3000/';
  const protectedResourceUrl = config.requestTarget;
  await fetchWithContext('UMA configuration readiness check', umaDiscoveryUrl, { method: 'GET' });
  try {
    const cssResponse = await fetch(cssBaseUrl, { method: 'GET' });
    if (cssResponse.status === 0) throw new Error('no HTTP status returned');
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    throw new Error(formatFetchError('CSS host readiness check', 'GET', cssBaseUrl, `failed: ${reason}`));
  }

  try {
    const response = await fetch(protectedResourceUrl, { method: 'GET' });
    if (response.status === 0) {
      throw new Error('no HTTP status returned');
    }
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    throw new Error(formatFetchError('Protected SPO2 resource readiness check', 'GET', protectedResourceUrl, `failed: ${reason}`));
  }

  await fetchWithContext('Policy endpoint readiness check', config.policyEndpoint, {
    method: 'GET',
    headers: policyHeaders(config.ownerWebId),
  });
}

async function waitForReadiness(config, timeoutMs) {
  const started = nowMs();
  let lastError = null;
  while (nowMs() - started < timeoutMs) {
    try {
      await verifyUmaEndpointsReachable(config);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for UMA/CSS readiness after ${timeoutMs} ms. Last error: ${lastError ? lastError.message : 'unknown'}`);
}

async function startManagedUmaStack(config, umaRepo, outputDir, runId) {
  const logFile = path.join(outputDir, `${BENCHMARK_NAME}-${runId}.uma.log`);
  console.log(`[benchmark:${BENCHMARK_NAME}] managed mode enabled; starting UMA/CSS stack`);
  const child = spawnLogged(config.umaStartCommand, config.umaStartArgs, { cwd: umaRepo, env: process.env }, logFile);
  console.log(`[benchmark:${BENCHMARK_NAME}] started UMA/CSS: ${child.displayCommand}`);
  console.log(`[benchmark:${BENCHMARK_NAME}] waiting for readiness checks`);
  try {
    await waitForReadiness(config, config.readinessTimeoutMs);
  } catch (error) {
    stopChild(child);
    await waitForChildExit(child);
    throw error;
  }
  console.log(`[benchmark:${BENCHMARK_NAME}] readiness checks passed`);
  return child;
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const opts = parseArgs(process.argv.slice(2));
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

  const policy0Path = path.join(umaRepo, 'packages', 'uma', 'config', 'rules', 'odrl', 'policy0.ttl');
  if (!fs.existsSync(policy0Path)) {
    throw new Error(`Expected policy0.ttl at ${policy0Path}`);
  }

  const config = {
    ...opts,
    existingPolicyPath: policy0Path,
    existingPolicyBody: fs.readFileSync(policy0Path, 'utf8'),
  };

  fs.mkdirSync(config.outputDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runsPath = path.join(config.outputDir, `${BENCHMARK_NAME}-${runId}.runs.jsonl`);
  const summaryPath = path.join(config.outputDir, `${BENCHMARK_NAME}-${runId}.summary.json`);
  const generatedSets = ensureGeneratedPolicySets(config, repoRoot);
  let managedUma = null;
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (managedUma) {
      stopChild(managedUma);
      await waitForChildExit(managedUma);
      console.log(`[benchmark:${BENCHMARK_NAME}] cleanup completed`);
    }
  };
  process.on('SIGINT', () => { cleanup().finally(() => process.exit(130)); });
  process.on('SIGTERM', () => { cleanup().finally(() => process.exit(143)); });

  try {
    if (config.managedStack) {
      managedUma = await startManagedUmaStack(config, umaRepo, config.outputDir, runId);
    } else {
      console.log(`[benchmark:${BENCHMARK_NAME}] unmanaged mode enabled; assuming UMA/CSS already running`);
      await waitForReadiness(config, config.readinessTimeoutMs);
      console.log(`[benchmark:${BENCHMARK_NAME}] readiness checks passed`);
    }

    const rows = [];
    const levels = [];

    for (const generatedSet of generatedSets) {
      const benchmarkPolicyCount = generatedSet.benchmark_policy_count;
      const generatedFile = generatedSet.generated_file;
      console.log(`[benchmark:${BENCHMARK_NAME}] policy count level ${benchmarkPolicyCount} starting`);

      const deletedBenchmarkPolicies = await cleanupBenchmarkPolicies(config);
      const existingSeedStatus = await ensureExistingPolicy0Loaded(config);
      console.log(`[benchmark:${BENCHMARK_NAME}] loading generated policies from ${generatedFile}`);
      const benchmarkSeed = await seedBenchmarkPolicies(config, generatedFile);
      console.log(
        `[benchmark:${BENCHMARK_NAME}] POST generated ODRL policies status=${benchmarkSeed.status} count=${benchmarkPolicyCount}`
      );
      const inventory = await readPolicyInventory(config, benchmarkPolicyCount);
      console.log(
        `[benchmark:${BENCHMARK_NAME}] loaded graph stats: benchmark_policies=${inventory.benchmark_policy_count} quads=${inventory.policy_quad_count} generated_file=${generatedFile}`
      );

      if (inventory.benchmark_policy_count !== benchmarkPolicyCount) {
        throw new Error(
          `Policy count mismatch for ${benchmarkPolicyCount}: loaded benchmark policies=${inventory.benchmark_policy_count}`
        );
      }
      if (inventory.matching_benchmark_policies_loaded !== 1) {
        throw new Error(
          `Expected exactly one matching benchmark policy for count=${benchmarkPolicyCount}, got ${inventory.matching_benchmark_policies_loaded}.`
        );
      }

      console.log(`[benchmark:${BENCHMARK_NAME}] running readiness probe for policy count ${benchmarkPolicyCount}`);
      await runReadinessProbe(config, benchmarkPolicyCount, 30000, 500);

      const levelRows = [];
      const total = config.warmupIterations + config.iterations;
      for (let index = 0; index < total; index += 1) {
        const phase = index < config.warmupIterations ? 'warmup' : 'measured';
        console.log(`[benchmark:${BENCHMARK_NAME}] ${phase} iteration ${index + 1}/${total}`);
        const row = await runUmaAccessIteration(config, phase, index + 1, benchmarkPolicyCount, inventory);
        row.level_setup = {
          deleted_prior_benchmark_policies: deletedBenchmarkPolicies,
          existing_policy_seed_status: existingSeedStatus,
          benchmark_policy_seed_status: benchmarkSeed.status,
          generated_policy_file: generatedFile,
        };
        rows.push(row);
        levelRows.push(row);
        if (index < total - 1) {
          await sleep(config.interIterationDelayMs);
        }
      }
      const aggregates = aggregateLevelRows(levelRows);
      levels.push({
        benchmark_policy_count: benchmarkPolicyCount,
        generated_policy_file: generatedFile,
        generated_matching_policy_count: generatedSet.generated_matching_policy_count,
        existing_policy_count: inventory.existing_policy_count,
        total_loaded_policy_count: inventory.total_loaded_policy_count,
        policy_quad_count: inventory.policy_quad_count,
        matching_benchmark_policies_loaded: inventory.matching_benchmark_policies_loaded,
        warmup_iterations: config.warmupIterations,
        measured_iterations: config.iterations,
        ...aggregates,
      });
    }

    const latexTableRows = levels.map((level) => ({
      benchmark_policy_count: level.benchmark_policy_count,
      policy_quad_count: level.policy_quad_count,
      token_exchange_mean_ms: level.metrics.uma_token_exchange_ms.mean,
      total_first_access_mean_ms: level.metrics.total_first_access_ms.mean,
      odrl_evaluation_mean_ms: level.metrics.odrl_evaluation_ms.mean,
    }));

    const summary = {
      benchmark_name: BENCHMARK_NAME,
      generated_at: new Date().toISOString(),
      run_id: runId,
      output_dir: config.outputDir,
      generated_policy_directory: generatedPolicyDirectory(repoRoot),
      existing_policy_path: config.existingPolicyPath,
      request: {
        requester_webid: config.requesterWebId,
        target: config.requestTarget,
        action: config.requestAction,
        expected_outcome: 'authorized',
      },
      config: {
        counts: config.counts,
        warmup_iterations: config.warmupIterations,
        measured_iterations: config.iterations,
        inter_iteration_delay_ms: config.interIterationDelayMs,
        policy_endpoint: config.policyEndpoint,
        owner_webid: config.ownerWebId,
        claim_token_format: config.claimTokenFormat,
        allow_type_e_distractors: config.allowTypeE,
        managed_stack: config.managedStack,
      },
      levels,
      runs_path: runsPath,
      odrl_evaluation_ms_supported: false,
      limitations: [
        'odrl_evaluation_ms is not isolated because UMA does not expose a dedicated ODRL evaluation timing hook.',
      ],
      latex_table_rows: latexTableRows,
      observation_checks: {
        expected: false,
        note: 'No stream-observation checks are required for this benchmark.',
      },
      requires_unrelated_alert_assertions: false,
    };

    const lines = rows.map((row) => JSON.stringify(row));
    fs.writeFileSync(runsPath, `${lines.join('\n')}\n`);
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`[benchmark:${BENCHMARK_NAME}] output summary path: ${summaryPath}`);
    console.log(JSON.stringify({ summary_path: summaryPath, runs_path: runsPath }, null, 2));
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`[benchmark:${BENCHMARK_NAME}] FAILED: ${error.message}`);
  process.exitCode = 1;
});
