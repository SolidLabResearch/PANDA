#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { client: WebSocketClient } = require('websocket');

const RUNS = Number(process.env.RUNS || '5');
const STREAM = process.env.STREAM || 'http://localhost:3000/alice/spo2/';
const WS_URL = process.env.WS_URL || 'ws://localhost:8080/';
const WEBHOOK_CHANNEL = process.env.WEBHOOK_CHANNEL || 'http://localhost:3000/.notifications/WebhookChannel2023/';
const WEBHOOK_SEND_TO = process.env.WEBHOOK_SEND_TO || 'http://localhost:8080/';
const OFFSETS = [0, 500, 1000, 1500];
const VALUES = [85, 85, 85, 85];
const T5_TIMEOUT_10_MS = Number(process.env.T5_TIMEOUT_10_MS || '10000');
const T5_TIMEOUT_30_MS = Number(process.env.T5_TIMEOUT_30_MS || '30000');
const T5_POLL_INTERVAL_MS = Number(process.env.T5_POLL_INTERVAL_MS || '75');
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || '20000');
const INTER_RUN_DELAY_MS = Number(process.env.INTER_RUN_DELAY_MS || '6000');
const WARMUP_MAX_ATTEMPTS = Number(process.env.WARMUP_MAX_ATTEMPTS || '5');
const LOG_FILE = path.resolve(process.env.PANDA_LOG_FILE || fs.readFileSync('/tmp/panda_obs_log.txt', 'utf8').trim());

const query = `PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>

REGISTER RStream <output_obs_batch_${Date.now()}> AS
SELECT ?s ?spo2Value
FROM NAMED WINDOW :w1 ON STREAM <${STREAM}> [RANGE 6300 STEP 1701]
WHERE {
  WINDOW :w1 {
    ?s saref:hasValue ?spo2Value .
    ?s saref:relatesToProperty <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2> .
  }
}`;

const rules = `@prefix saref: <https://saref.etsi.org/core/>.
@prefix math: <http://www.w3.org/2000/10/swap/math#>.
@prefix ex: <http://example.org/>.

{ ?s saref:hasValue ?spo2Value . ?spo2Value math:lessThan 90. } => { ?s ex:alert "SPO2_LOW". }.`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMs(iso) {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function parseMeasure(line) {
  const ts = (line.match(/timestamp=([^\s]+)/) || [])[1];
  const eventId = (line.match(/event_id=([^\s]+)/) || [])[1];
  const resource = (line.match(/resource=([^\s]+)/) || [])[1] || null;
  const statusMatch = line.match(/status=(\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  if (line.includes('[MEASURE][INGEST]') && ts) return { stage: 't1', ts, eventId, line };
  if (line.includes('[MEASURE][RSP] event_added') && ts) return { stage: 't2', ts, eventId, line };
  if (line.includes('[MEASURE][RULE] matched') && ts) return { stage: 't3', ts, eventId, line };
  if (line.includes('[MEASURE][ALERT] write_start') && ts) return { stage: 't4', ts, eventId, line };
  if (line.includes('[MEASURE][ALERT] write_success') && ts) return { stage: 't5', ts, eventId, resource, line };
  if (line.includes('[VALIDATION][ALERT][WRITE_RESPONSE]')) return { stage: 'write_response', eventId, status, line };
  return null;
}

function readNewLines(cursor) {
  const stat = fs.statSync(LOG_FILE);
  if (stat.size === cursor) return { cursor, lines: [] };
  const fd = fs.openSync(LOG_FILE, 'r');
  const buffer = Buffer.alloc(stat.size - cursor);
  fs.readSync(fd, buffer, 0, stat.size - cursor, cursor);
  fs.closeSync(fd);
  return { cursor: stat.size, lines: buffer.toString('utf8').split(/\r?\n/) };
}

async function postEvent(eventId, value, timestamp) {
  const ttl = `<${eventId}> <https://saref.etsi.org/core/hasValue> "${value}"^^<http://www.w3.org/2001/XMLSchema#decimal> .\n`
    + `<${eventId}> <https://saref.etsi.org/core/relatesToProperty> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2> .\n`
    + `<${eventId}> <https://saref.etsi.org/core/hasTimestamp> "${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .\n`;
  const response = await fetch(STREAM, {
    method: 'POST',
    headers: { 'Content-Type': 'text/turtle' },
    body: ttl,
  });
  const body = await response.text().catch(() => '');
  if (!(response.status === 200 || response.status === 201)) {
    throw new Error(`POST failed ${response.status}: ${body}`);
  }
}

async function registerWebhook() {
  const payload = {
    '@context': ['https://www.w3.org/ns/solid/notification/v1'],
    type: 'http://www.w3.org/ns/solid/notifications#WebhookChannel2023',
    topic: STREAM,
    sendTo: WEBHOOK_SEND_TO,
  };
  const response = await fetch(WEBHOOK_CHANNEL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(payload),
  });
  const body = await response.text().catch(() => '');
  console.log(`[DEBUG] webhook register status=${response.status} channel=${WEBHOOK_CHANNEL} topic=${STREAM} sendTo=${WEBHOOK_SEND_TO}`);
  if (!(response.status === 200 || response.status === 201)) {
    throw new Error(`webhook_registration_failed status=${response.status} body=${body}`);
  }
}

async function waitForWriteSuccess(cursor, t4EventId) {
  const startedAt = Date.now();
  const pollDeadline = startedAt + T5_TIMEOUT_30_MS;
  const mark10At = startedAt + T5_TIMEOUT_10_MS;
  let nextCursor = cursor;
  let writeStatus = null;
  let observedBy10s = false;
  console.log(`[DEBUG] polling started event_id=${t4EventId} timeout_10_ms=${T5_TIMEOUT_10_MS} timeout_30_ms=${T5_TIMEOUT_30_MS} poll_interval_ms=${T5_POLL_INTERVAL_MS}`);

  while (Date.now() < pollDeadline) {
    const out = readNewLines(nextCursor);
    nextCursor = out.cursor;

    for (const line of out.lines) {
      const parsed = parseMeasure(line);
      if (!parsed) continue;

      if (parsed.stage === 'write_response' && parsed.eventId === t4EventId && parsed.status !== null) {
        writeStatus = parsed.status;
      }

      if (parsed.stage === 't5' && parsed.eventId === t4EventId) {
        const now = Date.now();
        const timeToWriteSuccessMs = now - startedAt;
        observedBy10s = now <= mark10At;
        console.log(`[DEBUG] write_success found at ${parsed.ts} event_id=${t4EventId} time_to_write_success_ms=${timeToWriteSuccessMs}`);
        return {
          found: true,
          cursor: nextCursor,
          t5: parsed.ts,
          writeStatus,
          writeSuccessResource: parsed.resource || null,
          writeSuccessLine: parsed.line,
          observedBy10s,
          observedBy30s: true,
          timeToWriteSuccessMs,
          timeoutAt30s: null,
        };
      }
    }

    await sleep(T5_POLL_INTERVAL_MS);
  }

  console.log(`[DEBUG] write_success timeout_at_30s event_id=${t4EventId} timeout_ms=${T5_TIMEOUT_30_MS}`);
  return {
    found: false,
    cursor: nextCursor,
    t5: null,
    writeStatus,
    writeSuccessResource: null,
    writeSuccessLine: null,
    observedBy10s: false,
    observedBy30s: false,
    timeToWriteSuccessMs: null,
    timeoutAt30s: T5_TIMEOUT_30_MS,
  };
}

async function executeBurst(runLabel, cursor) {
  const base = Date.now();
  const ids = [1, 2, 3, 4].map(() => `${STREAM.replace(/\/$/, '')}/${randomUUID()}`);
  const times = OFFSETS.map((offset) => new Date(base + offset).toISOString());
  const stages = { t0: times[0], t1: null, t2: null, t3: null, t4: null, t5: null };
  const trigger = { t3_event_id: null, t4_event_id: null, t5_event_id: null };
  let write_response_status = null;
  let write_success_resource = null;
  let write_success_line = null;
  let write_success_observed_10s = false;
  let write_success_observed_30s = false;
  let time_to_write_success_ms = null;
  let timeout_at_30s = null;
  const evidence = {};

  for (let i = 0; i < 4; i += 1) {
    await postEvent(ids[i], VALUES[i], times[i]);
    if (i < 3) await sleep(500);
  }

  const runDeadline = Date.now() + RUN_TIMEOUT_MS;
  let rejectedReason = null;
  let t4Detected = false;
  let nextCursor = cursor;

  while (Date.now() < runDeadline) {
    const out = readNewLines(nextCursor);
    nextCursor = out.cursor;

    for (const line of out.lines) {
      const parsed = parseMeasure(line);
      if (!parsed) continue;

      if ((parsed.stage === 't1' || parsed.stage === 't2') && parsed.eventId === ids[0] && !stages[parsed.stage]) {
        stages[parsed.stage] = parsed.ts;
        evidence[parsed.stage] = line;
      }

      if ((parsed.stage === 't3' || parsed.stage === 't4') && ids.includes(parsed.eventId || '')) {
        if (!stages[parsed.stage]) {
          stages[parsed.stage] = parsed.ts;
          evidence[parsed.stage] = line;
        }
        if (parsed.stage === 't3' && !trigger.t3_event_id) trigger.t3_event_id = parsed.eventId;
        if (parsed.stage === 't4' && !trigger.t4_event_id) {
          trigger.t4_event_id = parsed.eventId;
          t4Detected = true;
          console.log(`[DEBUG] ${runLabel} t4 detected at ${parsed.ts} event_id=${parsed.eventId}`);
        }
      }
    }

    if (t4Detected && trigger.t4_event_id) {
      const t5Result = await waitForWriteSuccess(nextCursor, trigger.t4_event_id);
      nextCursor = t5Result.cursor;
      write_response_status = t5Result.writeStatus;
      write_success_resource = t5Result.writeSuccessResource;
      write_success_line = t5Result.writeSuccessLine;
      write_success_observed_10s = t5Result.observedBy10s;
      write_success_observed_30s = t5Result.observedBy30s;
      time_to_write_success_ms = t5Result.timeToWriteSuccessMs;
      timeout_at_30s = t5Result.timeoutAt30s;
      if (t5Result.found) {
        stages.t5 = t5Result.t5;
        trigger.t5_event_id = trigger.t4_event_id;
        evidence.t5 = t5Result.writeSuccessLine;
      } else {
        rejectedReason = 'timeout_at_30s';
      }
      break;
    }

    await sleep(100);
  }

  let accepted = Object.values(stages).every(Boolean);
  if (!accepted && !rejectedReason) {
    const missingStage = Object.entries(stages).find(([, v]) => !v)?.[0] || 'unknown_stage';
    rejectedReason = `missing_${missingStage}`;
  }

  if (accepted && write_response_status !== 201) {
    accepted = false;
    rejectedReason = `write_status_${write_response_status ?? 'missing'}`;
  }

  return {
    cursor: nextCursor,
    row: {
      accepted,
      rejected_reason: accepted ? null : rejectedReason,
      event_ids: { A1: ids[0], A2: ids[1], A3: ids[2], A4: ids[3] },
      values: { A1: VALUES[0], A2: VALUES[1], A3: VALUES[2], A4: VALUES[3] },
      ...stages,
      ...trigger,
      write_response_status,
      write_success_resource,
      write_success_line,
      write_success_observed_10s,
      write_success_observed_30s,
      time_to_write_success_ms,
      timeout_at_30s,
      latencies: {
        ingestion_ms: stages.t1 ? toMs(stages.t1) - toMs(stages.t0) : null,
        rsp_ms: stages.t2 ? toMs(stages.t2) - toMs(stages.t1) : null,
        rule_trigger_delay_ms: stages.t3 ? toMs(stages.t3) - toMs(stages.t2) : null,
        write_ms: stages.t5 ? toMs(stages.t5) - toMs(stages.t4) : null,
        total_ms: stages.t5 ? toMs(stages.t5) - toMs(stages.t0) : null,
      },
      evidence,
    },
  };
}

async function main() {
  const wsClient = new WebSocketClient();
  const conn = await new Promise((resolve, reject) => {
    wsClient.on('connectFailed', reject);
    wsClient.on('connect', resolve);
    wsClient.connect(WS_URL, 'solid-stream-aggregator-protocol');
  });
  conn.sendUTF(JSON.stringify({ query, rules, type: 'live' }));
  await sleep(1200);
  await registerWebhook();

  let cursor = fs.statSync(LOG_FILE).size;
  const rows = [];

  // Warm-up until ingest+rsp+rule+write_success are observed in one burst.
  let warmupPassed = false;
  let warmupAttempts = 0;
  while (!warmupPassed && warmupAttempts < WARMUP_MAX_ATTEMPTS) {
    warmupAttempts += 1;
    const warm = await executeBurst(`warmup_${warmupAttempts}`, cursor);
    cursor = warm.cursor;
    warmupPassed = warm.row.accepted;
    console.log(`[DEBUG] warmup attempt=${warmupAttempts} accepted=${warm.row.accepted} reason=${warm.row.rejected_reason || 'none'} write_status=${warm.row.write_response_status ?? 'missing'}`);
  }
  if (!warmupPassed) {
    throw new Error(`warmup_failed_after_${WARMUP_MAX_ATTEMPTS}_attempts`);
  }

  for (let run = 1; run <= RUNS; run += 1) {
    const measured = await executeBurst(`run_${run}`, cursor);
    cursor = measured.cursor;
    rows.push({
      run,
      ...measured.row,
    });
    await sleep(INTER_RUN_DELAY_MS);
  }

  conn.close();

  const success = rows.filter((row) => row.accepted);
  const completed = rows.filter((row) => row.write_success_observed_30s);
  const metricKeys = ['ingestion_ms', 'rsp_ms', 'rule_trigger_delay_ms', 'write_ms', 'total_ms'];
  const distributions = {};
  for (const key of metricKeys) {
    const values = completed.map((row) => row.latencies[key]).filter((v) => v !== null);
    distributions[key] = {
      count: values.length,
      avg: mean(values),
      median: median(values),
      p95: percentile(values, 95),
    };
  }

  const result = {
    config: {
      runs: RUNS,
      stream: STREAM,
      window: { range_ms: 6300, step_ms: 1701 },
      offsets_ms: OFFSETS,
      values: VALUES,
      t5_timeout_10_ms: T5_TIMEOUT_10_MS,
      t5_timeout_30_ms: T5_TIMEOUT_30_MS,
      t5_poll_interval_ms: T5_POLL_INTERVAL_MS,
      inter_run_delay_ms: INTER_RUN_DELAY_MS,
      warmup_max_attempts: WARMUP_MAX_ATTEMPTS,
      log_file: LOG_FILE,
    },
    completion_rate_10s: rows.length ? rows.filter((row) => row.write_success_observed_10s).length / rows.length : 0,
    completion_rate_30s: rows.length ? rows.filter((row) => row.write_success_observed_30s).length / rows.length : 0,
    success_rate: rows.length ? success.length / rows.length : 0,
    rejected_runs: rows.length - success.length,
    rows,
    distributions,
  };

  const outFile = path.resolve(
    'benchmark-results',
    `deterministic-ab-burst-5runs-async-t5-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ outFile, ...result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', error: error.message }, null, 2));
  process.exitCode = 1;
});
