#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { client: WebSocketClient } = require('websocket');
const { runDerivedPreflight } = require('../uma/preflight-derived');

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function toMs(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? value.toISOString() : String(value);
  if (!timestamp.endsWith('Z')) {
    throw new Error(`Benchmark timestamp must end with Z: ${timestamp}`);
  }
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Benchmark timestamp is not parseable: ${timestamp}`);
  }
  return timestamp;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAuthenticateHeader(header) {
  if (!header) throw new Error('Missing WWW-Authenticate header');
  if (!/^UMA\s+/i.test(header)) throw new Error(`Expected UMA challenge, got: ${header}`);

  const params = Object.fromEntries(
    header.replace(/^UMA\s+/i, '').split(/\s*,\s*/).map((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return [part.trim(), ''];
      return [part.slice(0, idx).trim(), part.slice(idx + 1).trim().replace(/^"|"$/g, '')];
    })
  );

  if (!params.as_uri || !params.ticket) {
    throw new Error(`Invalid UMA challenge: ${header}`);
  }

  const tokenEndpoint = new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString();
  return { ticket: params.ticket, tokenEndpoint };
}

function parseQueryWindow(query) {
  const m = query.match(/\[\s*RANGE\s+(\d+)\s+STEP\s+(\d+)\s*\]/i);
  if (!m) throw new Error('Could not parse RANGE/STEP from query');
  return { rangeMs: Number(m[1]), stepMs: Number(m[2]) };
}

function parseStreamFromQuery(query) {
  const m = query.match(/ON\s+STREAM\s+<([^>]+)>/i);
  if (!m) throw new Error('Could not parse ON STREAM <...> from query');
  return m[1];
}

function findLatestPandaLog(cwd) {
  const candidates = [];
  const scanDir = (dir, pattern) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (!pattern.test(entry)) continue;
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isFile()) candidates.push({ file: full, mtimeMs: stat.mtimeMs });
    }
  };

  scanDir(path.join(cwd, 'benchmark-results'), /^panda-unified-trace-live-.*\.stdout\.log$/);
  scanDir(path.join(cwd, 'benchmark-results'), /^panda-.*\.log$/);
  scanDir(cwd, /^aggregator-.*\.log$/);

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file || '';
}

function parseMeasureLine(line) {
  const ts = line.match(/timestamp=([^\s]+)/)?.[1] || null;
  const eventId = line.match(/event_id=([^\s]+)/)?.[1] || null;
  if (!ts || !eventId) return null;
  const resource = line.match(/resource=([^\s]+)/)?.[1] || null;

  if (line.includes('[MEASURE][INGEST]')) return { stage: 't1', ts, eventId };
  if (line.includes('[MEASURE][RSP] event_added')) return { stage: 't2', ts, eventId };
  if (line.includes('[MEASURE][RULE] matched')) return { stage: 't3', ts, eventId };
  if (line.includes('[MEASURE][ALERT] write_start')) return { stage: 't4', ts, eventId };
  if (line.includes('[MEASURE][ALERT] write_success')) return { stage: 't5', ts, eventId, resource };
  return null;
}

function stageLatency(stages, from, to) {
  const a = stages[from] ? toMs(stages[from]) : null;
  const b = stages[to] ? toMs(stages[to]) : null;
  if (a === null || b === null) return null;
  return b - a;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const idx = Math.max(0, Math.min(rank, sorted.length - 1));
  return sorted[idx];
}

function summarize(values) {
  if (!values.length) return { count: 0, avg: null, median: null, p95: null };
  const avg = values.reduce((acc, v) => acc + v, 0) / values.length;
  return { count: values.length, avg, median: median(values), p95: percentile(values, 95) };
}

function fmtMs(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return Number(value).toFixed(3);
}

function printSingleTable(title, rows) {
  console.log(`\n${title}`);
  console.log('| Metric | Value (ms) |');
  console.log('|---|---:|');
  for (const row of rows) {
    console.log(`| ${row.metric} | ${fmtMs(row.value)} |`);
  }
}

function printSummaryTable(title, rows) {
  console.log(`\n${title}`);
  console.log('| Metric | Avg (ms) | Median (ms) | P95 (ms) |');
  console.log('|---|---:|---:|---:|');
  for (const row of rows) {
    console.log(`| ${row.metric} | ${fmtMs(row.avg)} | ${fmtMs(row.median)} | ${fmtMs(row.p95)} |`);
  }
}

function safeRatio(numerator, denominator) {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

function startWsRegistration({ wsUrl, query, rules }) {
  return new Promise((resolve, reject) => {
    const c = new WebSocketClient();
    c.on('connectFailed', (err) => reject(err));
    c.on('connect', (conn) => {
      conn.sendUTF(JSON.stringify({ query, rules, type: 'live' }));
      resolve(conn);
    });
    c.connect(wsUrl, 'solid-stream-aggregator-protocol');
  });
}

async function postEvent(streamUrl, eventId, value, issuedIso) {
  if (!eventId) {
    throw new Error('Benchmark event is missing an identifier');
  }
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`Benchmark event is missing a value for ${eventId}`);
  }
  const timestamp = normalizeTimestamp(issuedIso);
  const ttl = `<${eventId}> <https://saref.etsi.org/core/hasValue> "${value}"^^<http://www.w3.org/2001/XMLSchema#decimal> .\n`
    + `<${eventId}> <https://saref.etsi.org/core/relatesToProperty> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2> .\n`
    + `<${eventId}> <https://saref.etsi.org/core/hasTimestamp> "${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .\n`;

  const response = await fetch(streamUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/turtle' },
    body: ttl,
  });

  const body = await response.text().catch(() => '');
  if (!(response.status === 201 || response.status === 200)) {
    throw new Error(`Injection failed (${response.status}): ${body}`);
  }
}

async function exchangeToken(tokenEndpoint, ticket, claimToken, claimTokenFormat) {
  const payload = {
    grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
    ticket,
    claim_token: encodeURIComponent(claimToken),
    claim_token_format: claimTokenFormat,
  };

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }

  if (response.status !== 200 || !json?.access_token) {
    throw new Error(`Token exchange failed (${response.status}): ${raw}`);
  }

  return { tokenType: json.token_type || 'Bearer', accessToken: json.access_token };
}

async function measureGrantPath({ resourceUrl, claimToken, claimTokenFormat }) {
  const stages = { t6: null, t7: null, t8: null, t9: null, t10: null, t11: null };

  stages.t6 = new Date().toISOString();
  const challengeRes = await fetch(resourceUrl);
  stages.t7 = new Date().toISOString();

  const challengeStatus = challengeRes.status;
  const challengeHeader = challengeRes.headers.get('WWW-Authenticate') || '';
  if (challengeRes.status !== 401) {
    const body = await challengeRes.text().catch(() => '');
    throw new Error(`grant-path expected 401 challenge, got ${challengeRes.status}: ${body}`);
  }

  const parsedChallenge = parseAuthenticateHeader(challengeHeader);
  stages.t8 = new Date().toISOString();
  const token = await exchangeToken(parsedChallenge.tokenEndpoint, parsedChallenge.ticket, claimToken, claimTokenFormat);
  stages.t9 = new Date().toISOString();

  stages.t10 = new Date().toISOString();
  const finalRes = await fetch(resourceUrl, {
    headers: { Authorization: `${token.tokenType} ${token.accessToken}` },
  });
  stages.t11 = new Date().toISOString();

  if (finalRes.status !== 200) {
    const body = await finalRes.text().catch(() => '');
    throw new Error(`grant-path expected 200 authorized GET, got ${finalRes.status}: ${body}`);
  }

  const latencies = {
    challenge_latency_ms: stageLatency(stages, 't6', 't7'),
    token_latency_ms: stageLatency(stages, 't8', 't9'),
    protected_get_latency_ms: stageLatency(stages, 't10', 't11'),
    total_grant_path_ms: stageLatency(stages, 't6', 't11'),
  };

  return {
    stages,
    statuses: {
      challenge_status: challengeStatus,
      token_status: 200,
      protected_get_status: finalRes.status,
    },
    latencies,
    token,
  };
}

function readNewLines(logFile, cursor) {
  if (!fs.existsSync(logFile)) return { nextCursor: cursor, lines: [] };
  const stat = fs.statSync(logFile);
  let nextCursor = cursor;
  if (stat.size < nextCursor) nextCursor = 0;
  if (stat.size === nextCursor) return { nextCursor, lines: [] };

  const fd = fs.openSync(logFile, 'r');
  const length = stat.size - nextCursor;
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, nextCursor);
  fs.closeSync(fd);

  return {
    nextCursor: stat.size,
    lines: buffer.toString('utf8').split(/\r?\n/),
  };
}

async function runIteration({
  runIndex,
  streamUrl,
  logFile,
  logCursor,
  eventValueA,
  eventValueB,
  triggerDeltaMs,
  rangeMs,
  stepMs,
  waitBufferMs,
  pollMs,
  resourceUrl,
  reusedToken,
}) {
  const stages = { t_fetch_start: null, t_fetch_end: null, t_parse_done: null, t1: null, t2: null, t3: null, t4: null, t5: null };
  const eventIdA = `${streamUrl.replace(/\/$/, '')}/${randomUUID()}`;
  const eventIdB = `${streamUrl.replace(/\/$/, '')}/${randomUUID()}`;
  let writeSuccessResource = null;
  const tFetchStartMs = Date.now();
  stages.t_fetch_start = new Date(tFetchStartMs).toISOString();

  const windowEndMsA = Math.ceil((tFetchStartMs + 1) / stepMs) * stepMs;
  const triggerMsB = tFetchStartMs + rangeMs + triggerDeltaMs;
  const timeoutMs = triggerMsB + waitBufferMs;

  await postEvent(streamUrl, eventIdA, eventValueA, stages.t_fetch_start);
  await postEvent(streamUrl, eventIdB, eventValueB, new Date(triggerMsB).toISOString());

  const authHeader = `${reusedToken.tokenType} ${reusedToken.accessToken}`;
  const fetchResponse = await fetch(resourceUrl, { headers: { Authorization: authHeader } });
  const tFetchEndMs = Date.now();
  stages.t_fetch_end = new Date(tFetchEndMs).toISOString();
  if (fetchResponse.status !== 200) {
    const body = await fetchResponse.text().catch(() => '');
    return {
      run: runIndex,
      success: false,
      rejected_reason: `expected 200 reused-token GET, got ${fetchResponse.status}: ${body}`,
      event_id_A: eventIdA,
      event_id_B: eventIdB,
      window: { range_ms: rangeMs, step_ms: stepMs, window_end_A_iso: new Date(windowEndMsA).toISOString() },
      timeout_iso: new Date(timeoutMs).toISOString(),
      statuses: { reused_get_status: fetchResponse.status },
      stages,
      write_success_resource: writeSuccessResource,
      latencies: {
        fetch_latency_ms: stageLatency(stages, 't_fetch_start', 't_fetch_end'),
        parsing_latency_ms: null,
        ingestion_latency_ms: null,
        rsp_latency_ms: null,
        rule_latency_ms: null,
        write_latency_ms: null,
        total_latency_ms: null,
      },
      log_file: logFile,
      next_log_cursor: logCursor,
    };
  }
  await fetchResponse.text().catch(() => '');
  stages.t_parse_done = new Date().toISOString();

  let cursor = logCursor;
  while (Date.now() <= timeoutMs) {
    const { nextCursor, lines } = readNewLines(logFile, cursor);
    cursor = nextCursor;
    for (const line of lines) {
      const parsed = parseMeasureLine(line);
      if (!parsed || parsed.eventId !== eventIdA) continue;
      stages[parsed.stage] = stages[parsed.stage] || parsed.ts;
      if (parsed.stage === 't5' && parsed.resource) {
        writeSuccessResource = writeSuccessResource || parsed.resource;
      }
    }
    if (stages.t3 || stages.t5) break;
    await wait(pollMs);
  }

  let rejectedReason = '';
  if (!stages.t3 && !stages.t5) {
    rejectedReason = `timeout waiting event-driven completion for A before ${new Date(timeoutMs).toISOString()}`;
  }

  const missingStage = Object.entries(stages).find(([, value]) => !value)?.[0] || null;
  if (!rejectedReason && missingStage) {
    rejectedReason = `missing stage ${missingStage}`;
  }

  const latencies = {
    fetch_latency_ms: stageLatency(stages, 't_fetch_start', 't_fetch_end'),
    parsing_latency_ms: stageLatency(stages, 't_fetch_end', 't_parse_done'),
    ingestion_latency_ms: stageLatency(stages, 't_parse_done', 't1'),
    rsp_latency_ms: stageLatency(stages, 't1', 't2'),
    rule_latency_ms: stageLatency(stages, 't2', 't3'),
    write_latency_ms: stageLatency(stages, 't4', 't5'),
    total_latency_ms: stageLatency(stages, 't_fetch_start', 't5'),
  };

  const success = !rejectedReason
    && Object.values(stages).every(Boolean);

  return {
    run: runIndex,
    success,
    rejected_reason: success ? null : rejectedReason || 'validation_failed',
    event_id_A: eventIdA,
    event_id_B: eventIdB,
    window: { range_ms: rangeMs, step_ms: stepMs, window_end_A_iso: new Date(windowEndMsA).toISOString() },
    timeout_iso: new Date(timeoutMs).toISOString(),
    statuses: { reused_get_status: 200 },
    stages,
    write_success_resource: writeSuccessResource,
    latencies,
    log_file: logFile,
    next_log_cursor: cursor,
  };
}

async function main() {
  const cwd = process.cwd();
  const queryRaw = env('PANDA_QUERY_RAW', '');
  const rulesRaw = env('PANDA_RULES_RAW', '');
  const queryFile = env('PANDA_QUERY_FILE', path.join(cwd, 'benchmark-input', 'flow.query.rspql'));
  const rulesFile = env('PANDA_RULES_FILE', path.join(cwd, 'benchmark-input', 'flow.rules.n3'));
  const wsUrl = env('PANDA_WS_URL', 'ws://localhost:8080/');
  const claimToken = env('PANDA_UMA_CLAIM_TOKEN', 'http://localhost:3000/bob/profile/card#me');
  const claimTokenFormat = env('PANDA_UMA_CLAIM_TOKEN_FORMAT', 'urn:solidlab:uma:claims:formats:webid');
  const resourceUrl = env('PANDA_UMA_RESOURCE', 'http://localhost:3000/alice/derived/acc-x/');
  const logFile = env('PANDA_MONITOR_LOG_FILE', findLatestPandaLog(cwd));
  const waitBufferMs = Number(env('PANDA_WINDOW_TIMEOUT_BUFFER_MS', '10000'));
  const pollMs = Number(env('PANDA_LOG_POLL_MS', '250'));
  const iterations = Number(env('PANDA_ITERATIONS', '5'));
  const triggerDeltaMs = Number(env('PANDA_TRIGGER_DELTA_MS', '1000'));
  const eventValueA = env('PANDA_EVENT_VALUE_A', '81');
  const eventValueB = env('PANDA_EVENT_VALUE_B', '95');
  const skipWsRegister = ['1', 'true', 'yes', 'on'].includes(env('PANDA_SKIP_WS_REGISTER', '0').toLowerCase());

  if (!logFile) {
    throw new Error('No PANDA log file found. Set PANDA_MONITOR_LOG_FILE to a live PANDA log path.');
  }

  // Strict derived-resource preflight: fail before any measurement if UMA registration is stale.
  // A 500 on the resource means CSS/UMA-AS was restarted without re-running setup-alice-derived.
  await runDerivedPreflight({
    resourcePaths: ['alice/spo2/'],
  });

  const query = queryRaw || fs.readFileSync(queryFile, 'utf8');
  const rules = rulesRaw || (fs.existsSync(rulesFile) ? fs.readFileSync(rulesFile, 'utf8') : '');
  const { rangeMs, stepMs } = parseQueryWindow(query);
  const streamUrl = parseStreamFromQuery(query);
  const grantPathCold = await measureGrantPath({ resourceUrl, claimToken, claimTokenFormat });
  const grantPathWarm = await measureGrantPath({ resourceUrl, claimToken, claimTokenFormat });

  const ws = skipWsRegister ? null : await startWsRegistration({ wsUrl, query, rules });
  await wait(Number(env('PANDA_POST_REGISTER_WAIT_MS', '1000')));
  let logCursor = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const rows = [];
  for (let i = 1; i <= iterations; i += 1) {
    const row = await runIteration({
      runIndex: i,
      streamUrl,
      logFile,
      logCursor,
      eventValueA,
      eventValueB,
      triggerDeltaMs,
      rangeMs,
      stepMs,
      waitBufferMs,
      pollMs,
      resourceUrl,
      reusedToken: grantPathWarm.token,
    });
    logCursor = row.next_log_cursor;
    delete row.next_log_cursor;
    rows.push(row);
  }

  if (ws) ws.close();

  const successfulRows = rows.filter((r) => r.success);
  const metrics = {
    fetch_latency: summarize(successfulRows.map((r) => r.latencies.fetch_latency_ms).filter((v) => v !== null)),
    parsing_latency: summarize(successfulRows.map((r) => r.latencies.parsing_latency_ms).filter((v) => v !== null)),
    ingestion_latency: summarize(successfulRows.map((r) => r.latencies.ingestion_latency_ms).filter((v) => v !== null)),
    rsp_latency: summarize(successfulRows.map((r) => r.latencies.rsp_latency_ms).filter((v) => v !== null)),
    rule_latency: summarize(successfulRows.map((r) => r.latencies.rule_latency_ms).filter((v) => v !== null)),
    write_latency: summarize(successfulRows.map((r) => r.latencies.write_latency_ms).filter((v) => v !== null)),
    total_latency: summarize(successfulRows.map((r) => r.latencies.total_latency_ms).filter((v) => v !== null)),
  };

  const ratio = {
    rule_share_of_pipeline: {
      avg: safeRatio(metrics.rule_latency.avg, (metrics.ingestion_latency.avg ?? 0) + (metrics.rsp_latency.avg ?? 0) + (metrics.rule_latency.avg ?? 0) + (metrics.write_latency.avg ?? 0)),
      median: safeRatio(metrics.rule_latency.median, (metrics.ingestion_latency.median ?? 0) + (metrics.rsp_latency.median ?? 0) + (metrics.rule_latency.median ?? 0) + (metrics.write_latency.median ?? 0)),
      p95: safeRatio(metrics.rule_latency.p95, (metrics.ingestion_latency.p95 ?? 0) + (metrics.rsp_latency.p95 ?? 0) + (metrics.rule_latency.p95 ?? 0) + (metrics.write_latency.p95 ?? 0)),
    },
    rule_to_total: {
      avg: safeRatio(metrics.rule_latency.avg, metrics.total_latency.avg),
      median: safeRatio(metrics.rule_latency.median, metrics.total_latency.median),
      p95: safeRatio(metrics.rule_latency.p95, metrics.total_latency.p95),
    },
  };

  const rejectedCount = rows.length - successfulRows.length;
  const output = {
    status: rejectedCount === 0 ? 'ok' : 'partial',
    iterations_requested: iterations,
    success_rate: rows.length ? successfulRows.length / rows.length : 0,
    rejected_run_count: rejectedCount,
    control_plane: {
      grant_path_cold: grantPathCold,
      grant_path_warm: grantPathWarm,
    },
    data_plane: {
      metrics,
      ratio,
    },
    rows,
  };

  console.log('\nControl Plane (Cold vs Warm)');
  console.log('| Metric | Cold (ms) | Warm (ms) |');
  console.log('|---|---:|---:|');
  console.log(`| challenge_latency | ${fmtMs(grantPathCold.latencies.challenge_latency_ms)} | ${fmtMs(grantPathWarm.latencies.challenge_latency_ms)} |`);
  console.log(`| token_latency | ${fmtMs(grantPathCold.latencies.token_latency_ms)} | ${fmtMs(grantPathWarm.latencies.token_latency_ms)} |`);
  console.log(`| protected_get_latency | ${fmtMs(grantPathCold.latencies.protected_get_latency_ms)} | ${fmtMs(grantPathWarm.latencies.protected_get_latency_ms)} |`);
  console.log(`| total_grant_path | ${fmtMs(grantPathCold.latencies.total_grant_path_ms)} | ${fmtMs(grantPathWarm.latencies.total_grant_path_ms)} |`);

  printSummaryTable('Data Plane (Streaming, Measured Runs)', [
    {
      metric: 'fetch_latency',
      avg: metrics.fetch_latency.avg,
      median: metrics.fetch_latency.median,
      p95: metrics.fetch_latency.p95,
    },
    {
      metric: 'parsing_latency',
      avg: metrics.parsing_latency.avg,
      median: metrics.parsing_latency.median,
      p95: metrics.parsing_latency.p95,
    },
    {
      metric: 'ingestion_latency',
      avg: metrics.ingestion_latency.avg,
      median: metrics.ingestion_latency.median,
      p95: metrics.ingestion_latency.p95,
    },
    {
      metric: 'rsp_latency',
      avg: metrics.rsp_latency.avg,
      median: metrics.rsp_latency.median,
      p95: metrics.rsp_latency.p95,
    },
    {
      metric: 'rule_latency',
      avg: metrics.rule_latency.avg,
      median: metrics.rule_latency.median,
      p95: metrics.rule_latency.p95,
    },
    {
      metric: 'write_latency',
      avg: metrics.write_latency.avg,
      median: metrics.write_latency.median,
      p95: metrics.write_latency.p95,
    },
    {
      metric: 'total_latency',
      avg: metrics.total_latency.avg,
      median: metrics.total_latency.median,
      p95: metrics.total_latency.p95,
    },
  ]);

  console.log('\nRatio Analysis (Rule Dominance)');
  console.log('| Ratio | Avg | Median | P95 |');
  console.log('|---|---:|---:|---:|');
  console.log(`| rule_share_of_pipeline | ${fmtMs(ratio.rule_share_of_pipeline.avg)} | ${fmtMs(ratio.rule_share_of_pipeline.median)} | ${fmtMs(ratio.rule_share_of_pipeline.p95)} |`);
  console.log(`| rule_to_total | ${fmtMs(ratio.rule_to_total.avg)} | ${fmtMs(ratio.rule_to_total.median)} | ${fmtMs(ratio.rule_to_total.p95)} |`);

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', error: error.message }, null, 2));
  process.exitCode = 1;
});
