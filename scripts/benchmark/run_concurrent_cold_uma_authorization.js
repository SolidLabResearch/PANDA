#!/usr/bin/env node

'use strict';

/**
 * Cold concurrent UMA/ODRL authorization benchmark.
 *
 * This benchmark measures cold concurrent UMA/ODRL authorization pressure.
 * It does not measure PANDA stream-processing throughput.
 * Clients are released from an in-process barrier, and observed start skew is recorded.
 * RPTs are intentionally not reused.
 *
 * Example:
 * node scripts/benchmark/run_concurrent_cold_uma_authorization.js \
 *   --target-url http://localhost:3000/alice/spo2/ \
 *   --uma-token-endpoint http://localhost:4000/uma/token \
 *   --claim-token "$CLAIM_TOKEN" \
 *   --concurrency-levels 1,2,5,10,20 \
 *   --bursts 30
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CLAIM_TOKEN_FORMAT = 'http://openid.net/specs/openid-connect-core-1_0.html#IDToken';
const DEFAULT_WEBID_CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';
const DEFAULT_CONCURRENCY_LEVELS = [1, 2, 5, 10, 20];
const DEFAULT_BURSTS = 30;
const DEFAULT_BURST_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SCENARIO = 'cold-concurrent-same-resource';
const DEFAULT_BARRIER_SETTLE_MS = 75;
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SCENARIO_FILE = path.join(ROOT, 'benchmarks', 'scenarios', '10-uma-replayer-panda-derived-anomaly-e2e.json');

function parseArgs(argv) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaults = {
    benchmarkId: `cold-concurrent-uma-odrl-${timestamp}`,
    targetUrl: null,
    umaTokenEndpoint: null,
    claimToken: null,
    claimTokens: null,
    claimTokenFile: null,
    claimTokenFormat: DEFAULT_CLAIM_TOKEN_FORMAT,
    authorizedWebids: null,
    concurrencyLevels: DEFAULT_CONCURRENCY_LEVELS.slice(),
    bursts: DEFAULT_BURSTS,
    burstDelayMs: DEFAULT_BURST_DELAY_MS,
    outputDir: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipPreflightFullFlow: false,
  };

  const out = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    switch (key) {
      case '--benchmark-id':
        out.benchmarkId = readValue(argv, i, key);
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
      case '--authorized-webids':
        out.authorizedWebids = splitCsv(readValue(argv, i, key));
        i += 1;
        break;
      case '--concurrency-levels':
        out.concurrencyLevels = splitCsv(readValue(argv, i, key)).map((value) => Number(value));
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
      case '--output-dir':
        out.outputDir = readValue(argv, i, key);
        i += 1;
        break;
      case '--timeout-ms':
        out.timeoutMs = Number(readValue(argv, i, key));
        i += 1;
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

  if (!out.targetUrl) {
    throw new Error('--target-url is required');
  }
  if (!out.umaTokenEndpoint) {
    throw new Error('--uma-token-endpoint is required');
  }
  if (!Array.isArray(out.concurrencyLevels) || out.concurrencyLevels.length === 0 || out.concurrencyLevels.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`Invalid --concurrency-levels: ${String(out.concurrencyLevels)}`);
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

  if (!out.outputDir) {
    out.outputDir = path.join(ROOT, 'benchmarks', 'results', 'runs', out.benchmarkId, 'raw');
  } else if (!path.isAbsolute(out.outputDir)) {
    out.outputDir = path.resolve(process.cwd(), out.outputDir);
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
  node scripts/benchmark/run_concurrent_cold_uma_authorization.js [options]

Options:
  --benchmark-id <id>
  --target-url <url>
  --uma-token-endpoint <url>
  --claim-token <token>
  --claim-tokens <csv>
  --claim-token-file <path>
  --claim-token-format <format>
  --authorized-webids <csv>
  --concurrency-levels <csv>
  --bursts <n>
  --burst-delay-ms <n>
  --output-dir <path>
  --timeout-ms <n>
  --skip-preflight-full-flow
  --help
  -h`);
}

function splitCsv(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  if (ns === null || ns === undefined) return null;
  return Number(ns) / 1_000_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(rank, sorted.length - 1));
  return sorted[index];
}

function summarize(values) {
  const numeric = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (!numeric.length) {
    return {
      count: 0,
      mean: null,
      median: null,
      p95: null,
      p99: null,
      min: null,
      max: null,
    };
  }
  const sum = numeric.reduce((acc, value) => acc + value, 0);
  return {
    count: numeric.length,
    mean: sum / numeric.length,
    median: percentile(numeric, 50),
    p95: percentile(numeric, 95),
    p99: percentile(numeric, 99),
    min: numeric[0],
    max: numeric[numeric.length - 1],
  };
}

function roundMetric(value) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(3));
}

function extractUmaTicket(wwwAuthenticate) {
  if (!wwwAuthenticate) {
    throw new Error('Missing WWW-Authenticate header');
  }
  const header = String(wwwAuthenticate).trim();
  const ticketMatch = header.match(/(?:^|,\s*)ticket="?([^",]+)"?/i);
  if (!ticketMatch || !ticketMatch[1]) {
    throw new Error(`UMA ticket not found in WWW-Authenticate header: ${header}`);
  }
  return ticketMatch[1];
}

function parseUmaChallenge(wwwAuthenticate) {
  if (!wwwAuthenticate) {
    throw new Error('Missing WWW-Authenticate header');
  }
  const header = String(wwwAuthenticate).trim();
  if (!/^UMA\b/i.test(header)) {
    throw new Error(`WWW-Authenticate is not an UMA challenge: ${header}`);
  }
  const params = {};
  const paramPattern = /([A-Za-z_][A-Za-z0-9_-]*)=("(?:[^"\\]|\\.)*"|[^,\s]+)/g;
  let match;
  while ((match = paramPattern.exec(header)) !== null) {
    const key = match[1];
    const rawValue = match[2];
    params[key] = rawValue.startsWith('"') ? rawValue.slice(1, -1) : rawValue;
  }
  params.ticket = params.ticket || extractUmaTicket(header);
  return {
    raw: header,
    realm: params.realm || null,
    as_uri: params.as_uri || null,
    ticket: params.ticket,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...(options?.headers || {}),
      },
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function writeJsonl(file, object) {
  fs.appendFileSync(file, `${JSON.stringify(object)}\n`, 'utf8');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadScenarioDefaults() {
  try {
    const raw = fs.readFileSync(DEFAULT_SCENARIO_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const nurseWebId = parsed?.protected_result?.nurse_webid || 'http://localhost:3000/bob/profile/card#me';
    const ownerWebId = parsed?.protected_result?.owner_webid || 'http://localhost:3000/alice/profile/card#me';
    return {
      source: 'scenario-default',
      nurseWebId,
      ownerWebId,
    };
  } catch (_) {
    return {
      source: 'scenario-default-fallback',
      nurseWebId: 'http://localhost:3000/bob/profile/card#me',
      ownerWebId: 'http://localhost:3000/alice/profile/card#me',
    };
  }
}

function loadClaimTokensFromFile(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(resolved, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`Claim token file must contain a JSON array: ${resolved}`);
    }
    return parsed.map((value) => String(value).trim()).filter(Boolean);
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function resolveIdentities(opts) {
  const scenarioDefaults = loadScenarioDefaults();
  if (Array.isArray(opts.claimTokens) && opts.claimTokens.length > 0) {
    return opts.claimTokens.map((token, index) => validateIdentity({
      webid: inferWebId(token, opts.claimTokenFormat),
      claimToken: token,
      claimTokenFormat: opts.claimTokenFormat,
      identityIndex: index,
      webidIndex: index,
      claimTokenSource: 'cli',
    }));
  }

  if (opts.claimTokenFile) {
    const tokens = loadClaimTokensFromFile(opts.claimTokenFile);
    if (!tokens.length) {
      throw new Error(`No claim tokens found in file: ${opts.claimTokenFile}`);
    }
    return tokens.map((token, index) => validateIdentity({
      webid: inferWebId(token, opts.claimTokenFormat),
      claimToken: token,
      claimTokenFormat: opts.claimTokenFormat,
      identityIndex: index,
      webidIndex: index,
      claimTokenSource: 'file',
    }));
  }

  if (opts.claimToken) {
    return [validateIdentity({
      webid: inferWebId(opts.claimToken, opts.claimTokenFormat),
      claimToken: opts.claimToken,
      claimTokenFormat: opts.claimTokenFormat,
      identityIndex: 0,
      webidIndex: 0,
      claimTokenSource: 'cli',
    })];
  }

  if (Array.isArray(opts.authorizedWebids) && opts.authorizedWebids.length > 0) {
    const generated = tryGenerateClaimTokensFromWebids(opts.authorizedWebids, opts.claimTokenFormat);
    if (!generated) {
      throw new Error([
        'No reusable claim-token generation helper was found for --authorized-webids.',
        'This repository’s working UMA scenarios use plain WebID claim tokens.',
        'Pass one of:',
        '  --claim-token <token>',
        '  --claim-tokens <csv>',
        '  --claim-token-file <path>',
      ].join('\n'));
    }
    return generated.map((entry, index) => validateIdentity({
      webid: entry.webid,
      claimToken: entry.claimToken,
      claimTokenFormat: entry.claimTokenFormat,
      identityIndex: index,
      webidIndex: index,
      claimTokenSource: entry.claimTokenSource,
    }));
  }

  if (scenarioDefaults.nurseWebId) {
    return [validateIdentity({
      webid: scenarioDefaults.nurseWebId,
      claimToken: scenarioDefaults.nurseWebId,
      claimTokenFormat: DEFAULT_WEBID_CLAIM_TOKEN_FORMAT,
      identityIndex: 0,
      webidIndex: 0,
      claimTokenSource: 'scenario-default',
    })];
  }

  throw new Error([
    'No claim token configuration was found.',
    'Pass one of:',
    '  --claim-token <token>',
    '  --claim-tokens <csv>',
    '  --claim-token-file <path>',
    'If you want WebID-style tokens, the repo scenarios use plain WebID claim tokens with format:',
    `  ${DEFAULT_WEBID_CLAIM_TOKEN_FORMAT}`,
  ].join('\n'));
}

function tryGenerateClaimTokensFromWebids(webids, claimTokenFormat) {
  if (claimTokenFormat === DEFAULT_WEBID_CLAIM_TOKEN_FORMAT || claimTokenFormat === DEFAULT_CLAIM_TOKEN_FORMAT) {
    return webids.map((webid) => ({
      webid,
      claimToken: webid,
      claimTokenFormat: DEFAULT_WEBID_CLAIM_TOKEN_FORMAT,
      claimTokenSource: 'generated',
    }));
  }
  return null;
}

function inferWebId(claimToken, claimTokenFormat) {
  if (claimTokenFormat === DEFAULT_WEBID_CLAIM_TOKEN_FORMAT && /^https?:\/\//.test(claimToken)) {
    return claimToken;
  }
  if (/^https?:\/\//.test(claimToken)) {
    return claimToken;
  }
  return null;
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

function validateIdentity(identity) {
  assertRawWebIdClaimToken(identity.claimToken, identity.claimTokenFormat);
  return identity;
}

async function runColdUmaClient({
  benchmarkId,
  targetUrl,
  tokenEndpoint,
  timeoutMs,
  concurrency,
  burstIndex,
  clientIndex,
  identity,
  burstStartNs,
  startBarrier,
}) {
  const result = {
    benchmark_id: benchmarkId,
    scenario: DEFAULT_SCENARIO,
    concurrency,
    burst_index: burstIndex,
    client_index: clientIndex,
    target_url: targetUrl,
    status: 'error',
    error_message: null,
    challenge_status: null,
    token_status: null,
    authorized_status: null,
    challenge_latency_ms: null,
    token_exchange_latency_ms: null,
    authorized_get_latency_ms: null,
    total_latency_ms: null,
    burst_start_ns: burstStartNs.toString(),
    client_start_ns: null,
    client_end_ns: null,
    webid: identity.webid,
    claim_token_format: identity.claimTokenFormat,
    identity_index: identity.identityIndex,
    webid_index: identity.webidIndex,
    client_identity_index: identity.identityIndex,
    claim_token_source: identity.claimTokenSource,
  };

  try {
    await startBarrier.promise;
    const clientStartNs = nowNs();
    result.client_start_ns = clientStartNs.toString();

    const challengeStartedNs = nowNs();
    const challengeResponse = await fetchWithTimeout(targetUrl, {
      method: 'GET',
      headers: {
        Accept: '*/*',
      },
    }, timeoutMs);
    const challengeEndedNs = nowNs();
    result.challenge_status = challengeResponse.status;
    result.challenge_latency_ms = roundMetric(nsToMs(challengeEndedNs - challengeStartedNs));

    const wwwAuthenticate = challengeResponse.headers.get('WWW-Authenticate') || '';
    if (challengeResponse.status !== 401) {
      throw new Error(`Expected initial GET 401 UMA challenge, got ${challengeResponse.status}`);
    }

    const challenge = parseUmaChallenge(wwwAuthenticate);
    const ticket = extractUmaTicket(wwwAuthenticate);
    const actualTokenEndpoint = challenge.as_uri
      ? new URL('token', challenge.as_uri.endsWith('/') ? challenge.as_uri : `${challenge.as_uri}/`).toString()
      : tokenEndpoint;

    assertRawWebIdClaimToken(identity.claimToken, identity.claimTokenFormat);

    const tokenStartedNs = nowNs();
    // This UMA development setup expects JSON token requests with encodeURIComponent(WebID),
    // matching run_all_scenarios.js.
    const claimToken = identity.claimToken;
    const claimTokenFormat = identity.claimTokenFormat;
    const tokenResponse = await fetchWithTimeout(actualTokenEndpoint || tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
        ticket,
        claim_token: encodeURIComponent(claimToken),
        claim_token_format: claimTokenFormat,
      }),
    }, timeoutMs);
    const tokenEndedNs = nowNs();
    result.token_status = tokenResponse.status;
    result.token_exchange_latency_ms = roundMetric(nsToMs(tokenEndedNs - tokenStartedNs));

    const tokenBodyText = await tokenResponse.text().catch(() => '');
    let tokenBody;
    try {
      tokenBody = tokenBodyText ? JSON.parse(tokenBodyText) : null;
    } catch (_) {
      tokenBody = null;
    }
    if (!tokenResponse.ok) {
      throw new Error(`UMA token exchange failed status=${tokenResponse.status} body=${tokenBodyText}`);
    }
    const accessToken = tokenBody?.access_token;
    const tokenType = tokenBody?.token_type || 'Bearer';
    if (!accessToken) {
      throw new Error(`UMA token response missing access_token body=${tokenBodyText}`);
    }

    const authorizedStartedNs = nowNs();
    const authorizedResponse = await fetchWithTimeout(targetUrl, {
      method: 'GET',
      headers: {
        Accept: '*/*',
        Authorization: `${tokenType} ${accessToken}`,
      },
    }, timeoutMs);
    const authorizedEndedNs = nowNs();
    result.authorized_status = authorizedResponse.status;
    result.authorized_get_latency_ms = roundMetric(nsToMs(authorizedEndedNs - authorizedStartedNs));

    if (!authorizedResponse.ok) {
      const body = await authorizedResponse.text().catch(() => '');
      throw new Error(`Authorized GET failed status=${authorizedResponse.status} body=${body}`);
    }

    const clientEndNs = nowNs();
    result.client_end_ns = clientEndNs.toString();
    result.total_latency_ms = roundMetric(nsToMs(clientEndNs - clientStartNs));
    result.status = 'ok';
    return result;
  } catch (error) {
    const clientEndNs = nowNs();
    if (!result.client_start_ns) {
      result.client_start_ns = clientEndNs.toString();
    }
    result.client_end_ns = clientEndNs.toString();
    const startNs = BigInt(result.client_start_ns);
    result.total_latency_ms = roundMetric(nsToMs(clientEndNs - startNs));
    result.error_message = error?.message || String(error);
    return result;
  }
}

async function runBurst({
  benchmarkId,
  targetUrl,
  tokenEndpoint,
  timeoutMs,
  concurrency,
  burstIndex,
  identities,
  clientOutputFile,
}) {
  let resolveBarrier;
  const startBarrier = {
    promise: new Promise((resolve) => {
      resolveBarrier = resolve;
    }),
  };

  const clientPromises = Array.from({ length: concurrency }, (_, clientIndex) => {
    const baseIdentity = identities[clientIndex % identities.length];
    const identity = {
      ...baseIdentity,
      identityIndex: clientIndex % identities.length,
      webidIndex: clientIndex % identities.length,
    };
    return runColdUmaClient({
      benchmarkId,
      targetUrl,
      tokenEndpoint,
      timeoutMs,
      concurrency,
      burstIndex,
      clientIndex,
      identity,
      burstStartNs: 0n,
      startBarrier,
    });
  });

  await sleep(DEFAULT_BARRIER_SETTLE_MS);
  const burstStartNs = nowNs();
  resolveBarrier();
  const settled = await Promise.allSettled(clientPromises);
  const burstEndNs = nowNs();

  const clientResults = settled.map((entry, index) => {
    if (entry.status === 'fulfilled') {
      const value = entry.value;
      value.burst_start_ns = burstStartNs.toString();
      return value;
    }
    return {
      benchmark_id: benchmarkId,
      scenario: DEFAULT_SCENARIO,
      concurrency,
      burst_index: burstIndex,
      client_index: index,
      target_url: targetUrl,
      status: 'error',
      error_message: entry.reason?.message || String(entry.reason),
      challenge_status: null,
      token_status: null,
      authorized_status: null,
      challenge_latency_ms: null,
      token_exchange_latency_ms: null,
      authorized_get_latency_ms: null,
      total_latency_ms: null,
      burst_start_ns: burstStartNs.toString(),
      client_start_ns: null,
      client_end_ns: null,
      webid: null,
      claim_token_format: null,
      identity_index: index % identities.length,
      webid_index: index % identities.length,
      client_identity_index: index % identities.length,
      claim_token_source: null,
    };
  });

  for (const row of clientResults) {
    writeJsonl(clientOutputFile, row);
  }

  const startedNs = clientResults
    .map((row) => (row.client_start_ns ? BigInt(row.client_start_ns) : null))
    .filter(Boolean);
  const startSkewMs = startedNs.length > 1
    ? roundMetric(nsToMs(startedNs.reduce((max, value) => (value > max ? value : max), startedNs[0]) - startedNs.reduce((min, value) => (value < min ? value : min), startedNs[0])))
    : 0;
  const clientsSucceeded = clientResults.filter((row) => row.status === 'ok').length;
  const clientsFailed = clientResults.length - clientsSucceeded;

  return {
    benchmark_id: benchmarkId,
    scenario: DEFAULT_SCENARIO,
    concurrency,
    burst_index: burstIndex,
    clients_started: clientResults.length,
    clients_succeeded: clientsSucceeded,
    clients_failed: clientsFailed,
    failure_rate: clientResults.length ? clientsFailed / clientResults.length : null,
    burst_completion_time_ms: roundMetric(nsToMs(burstEndNs - burstStartNs)),
    start_skew_ms: startSkewMs,
    burst_start_ns: burstStartNs.toString(),
    burst_end_ns: burstEndNs.toString(),
    client_results: clientResults,
  };
}

async function runPreflight({
  targetUrl,
  tokenEndpoint,
  timeoutMs,
  identities,
  skipPreflightFullFlow,
}) {
  const initial = await fetchWithTimeout(targetUrl, {
    method: 'GET',
    headers: { Accept: '*/*' },
  }, timeoutMs);
  const initialHeader = initial.headers.get('WWW-Authenticate') || '';
  if (initial.status !== 401) {
    if (initial.status === 200) {
      throw new Error(`Preflight failed: target returned 200 on tokenless GET, so it is not protected: ${targetUrl}`);
    }
    throw new Error(`Preflight failed: expected initial GET 401 UMA challenge, got ${initial.status}`);
  }
  parseUmaChallenge(initialHeader);
  extractUmaTicket(initialHeader);

  if (skipPreflightFullFlow) {
    return;
  }

  const distinct = dedupeIdentities(identities);
  for (const identity of distinct) {
    const result = await runColdUmaClient({
      benchmarkId: 'preflight',
      targetUrl,
      tokenEndpoint,
      timeoutMs,
      concurrency: 1,
      burstIndex: -1,
      clientIndex: 0,
      identity,
      burstStartNs: nowNs(),
      startBarrier: { promise: Promise.resolve() },
    });
    if (result.challenge_status !== 401) {
      throw new Error(`Preflight failed for identity ${identity.webid || identity.claimToken}: expected challenge_status 401, got ${result.challenge_status}`);
    }
    if (result.status !== 'ok' || result.authorized_status !== 200) {
      throw new Error(`Preflight failed for identity ${identity.webid || identity.claimToken}: ${result.error_message || `authorized_status=${result.authorized_status}`}`);
    }
  }
}

function dedupeIdentities(identities) {
  const seen = new Set();
  const out = [];
  for (const identity of identities) {
    const key = `${identity.claimTokenFormat}::${identity.claimToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(identity);
  }
  return out;
}

function aggregateResults(clientResults, burstResults) {
  const byConcurrency = new Map();
  for (const row of clientResults) {
    const bucket = byConcurrency.get(row.concurrency) || { clientRows: [], burstRows: [] };
    bucket.clientRows.push(row);
    byConcurrency.set(row.concurrency, bucket);
  }
  for (const row of burstResults) {
    const bucket = byConcurrency.get(row.concurrency) || { clientRows: [], burstRows: [] };
    bucket.burstRows.push(row);
    byConcurrency.set(row.concurrency, bucket);
  }

  const perConcurrency = Array.from(byConcurrency.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([concurrency, bucket]) => {
      const successes = bucket.clientRows.filter((row) => row.status === 'ok').length;
      const failures = bucket.clientRows.length - successes;
      return {
        concurrency,
        bursts: bucket.burstRows.length,
        total_clients: bucket.clientRows.length,
        successful_clients: successes,
        failed_clients: failures,
        failure_rate: bucket.clientRows.length ? failures / bucket.clientRows.length : null,
        total_latency_ms: summarize(bucket.clientRows.map((row) => row.total_latency_ms)),
        challenge_latency_ms: summarize(bucket.clientRows.map((row) => row.challenge_latency_ms)),
        token_exchange_latency_ms: summarize(bucket.clientRows.map((row) => row.token_exchange_latency_ms)),
        authorized_get_latency_ms: summarize(bucket.clientRows.map((row) => row.authorized_get_latency_ms)),
        burst_completion_time_ms: summarize(bucket.burstRows.map((row) => row.burst_completion_time_ms)),
        start_skew_ms: summarize(bucket.burstRows.map((row) => row.start_skew_ms)),
      };
    });

  return {
    scenario: DEFAULT_SCENARIO,
    generated_at: new Date().toISOString(),
    concurrency_levels: perConcurrency,
  };
}

function writeSummary({
  summary,
  benchmarkId,
  opts,
  rawDir,
  aggregatedDir,
}) {
  const jsonPath = path.join(aggregatedDir, 'concurrent-cold-uma-summary.json');
  const mdPath = path.join(aggregatedDir, 'concurrent-cold-uma-summary.md');
  const json = {
    benchmark_id: benchmarkId,
    scenario: DEFAULT_SCENARIO,
    generated_at: new Date().toISOString(),
    target_url: opts.targetUrl,
    uma_token_endpoint: opts.umaTokenEndpoint,
    claim_token_format: opts.claimTokenFormat,
    concurrency_levels: opts.concurrencyLevels,
    bursts: opts.bursts,
    burst_delay_ms: opts.burstDelayMs,
    timeout_ms: opts.timeoutMs,
    raw_output_dir: rawDir,
    ...summary,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

  const lines = [
    `# Concurrent Cold UMA Summary`,
    ``,
    `- Benchmark ID: \`${benchmarkId}\``,
    `- Scenario: \`${DEFAULT_SCENARIO}\``,
    `- Target URL: \`${opts.targetUrl}\``,
    `- UMA token endpoint: \`${opts.umaTokenEndpoint}\``,
    `- Claim token format: \`${opts.claimTokenFormat}\``,
    `- Bursts per level: ${opts.bursts}`,
    `- Burst delay ms: ${opts.burstDelayMs}`,
    `- Timeout ms: ${opts.timeoutMs}`,
    ``,
    `| Concurrency | Success | Failure rate | Mean total ms | Median total ms | p95 total ms | Mean burst ms | Mean start skew ms |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const row of summary.concurrency_levels) {
    lines.push(
      `| ${row.concurrency} | ${row.successful_clients}/${row.total_clients} | ${formatPercent(row.failure_rate)} | ${formatMetric(row.total_latency_ms.mean)} | ${formatMetric(row.total_latency_ms.median)} | ${formatMetric(row.total_latency_ms.p95)} | ${formatMetric(row.burst_completion_time_ms.mean)} | ${formatMetric(row.start_skew_ms.mean)} |`
    );
  }
  lines.push('');
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');

  return { jsonPath, mdPath };
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function formatMetric(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(3);
}

async function runBenchmark(opts) {
  const rawDir = opts.outputDir;
  const runRoot = path.dirname(rawDir);
  const aggregatedDir = path.join(runRoot, 'aggregated');
  ensureDir(rawDir);
  ensureDir(aggregatedDir);

  const clientOutputFile = path.join(rawDir, 'concurrent-cold-uma-client-results.jsonl');
  const burstOutputFile = path.join(rawDir, 'concurrent-cold-uma-burst-results.jsonl');
  fs.writeFileSync(clientOutputFile, '', 'utf8');
  fs.writeFileSync(burstOutputFile, '', 'utf8');

  const identities = resolveIdentities(opts);

  console.log(`benchmark id: ${opts.benchmarkId}`);
  console.log(`target URL: ${opts.targetUrl}`);
  console.log(`UMA token endpoint: ${opts.umaTokenEndpoint}`);
  console.log(`concurrency levels: ${opts.concurrencyLevels.join(', ')}`);
  console.log(`bursts per level: ${opts.bursts}`);
  console.log(`burst delay ms: ${opts.burstDelayMs}`);
  console.log(`timeout ms: ${opts.timeoutMs}`);
  console.log(`identities: ${identities.length}`);

  await runPreflight({
    targetUrl: opts.targetUrl,
    tokenEndpoint: opts.umaTokenEndpoint,
    timeoutMs: opts.timeoutMs,
    identities,
    skipPreflightFullFlow: opts.skipPreflightFullFlow,
  });

  const allClientResults = [];
  const allBurstResults = [];

  for (const concurrency of opts.concurrencyLevels) {
    for (let burstIndex = 0; burstIndex < opts.bursts; burstIndex += 1) {
      console.log(`running concurrency=${concurrency} burst=${burstIndex + 1}/${opts.bursts}`);
      const burst = await runBurst({
        benchmarkId: opts.benchmarkId,
        targetUrl: opts.targetUrl,
        tokenEndpoint: opts.umaTokenEndpoint,
        timeoutMs: opts.timeoutMs,
        concurrency,
        burstIndex,
        identities,
        clientOutputFile,
      });
      const burstRow = { ...burst };
      delete burstRow.client_results;
      writeJsonl(burstOutputFile, burstRow);
      allClientResults.push(...burst.client_results);
      allBurstResults.push(burstRow);
      if (burstIndex < opts.bursts - 1 || concurrency !== opts.concurrencyLevels[opts.concurrencyLevels.length - 1]) {
        await sleep(opts.burstDelayMs);
      }
    }
  }

  const summary = aggregateResults(allClientResults, allBurstResults);
  const summaryPaths = writeSummary({
    summary,
    benchmarkId: opts.benchmarkId,
    opts,
    rawDir,
    aggregatedDir,
  });

  const totalSucceeded = allClientResults.filter((row) => row.status === 'ok').length;
  if (totalSucceeded === 0) {
    console.error('All clients failed across all bursts.');
    console.error(`client results: ${clientOutputFile}`);
    console.error(`burst results: ${burstOutputFile}`);
    console.error(`summary JSON: ${summaryPaths.jsonPath}`);
    console.error(`summary MD: ${summaryPaths.mdPath}`);
    process.exit(1);
  }

  console.log(`client results: ${clientOutputFile}`);
  console.log(`burst results: ${burstOutputFile}`);
  console.log(`summary JSON: ${summaryPaths.jsonPath}`);
  console.log(`summary MD: ${summaryPaths.mdPath}`);
  return {
    benchmarkId: opts.benchmarkId,
    rawDir,
    aggregatedDir,
    clientOutputFile,
    burstOutputFile,
    summaryJsonPath: summaryPaths.jsonPath,
    summaryMdPath: summaryPaths.mdPath,
    totalClients: allClientResults.length,
    totalSucceeded,
    totalFailed: allClientResults.length - totalSucceeded,
    summary,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await runBenchmark(opts);
}

module.exports = {
  DEFAULT_BARRIER_SETTLE_MS,
  DEFAULT_BURST_DELAY_MS,
  DEFAULT_BURSTS,
  DEFAULT_CLAIM_TOKEN_FORMAT,
  DEFAULT_CONCURRENCY_LEVELS,
  DEFAULT_SCENARIO,
  DEFAULT_SCENARIO_FILE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WEBID_CLAIM_TOKEN_FORMAT,
  ROOT,
  aggregateResults,
  dedupeIdentities,
  ensureDir,
  extractUmaTicket,
  fetchWithTimeout,
  inferWebId,
  loadClaimTokensFromFile,
  loadScenarioDefaults,
  parseArgs,
  parseUmaChallenge,
  resolveIdentities,
  runBenchmark,
  runBurst,
  runColdUmaClient,
  runPreflight,
  sleep,
  splitCsv,
  summarize,
  tryGenerateClaimTokensFromWebids,
  writeJsonl,
  writeSummary,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
