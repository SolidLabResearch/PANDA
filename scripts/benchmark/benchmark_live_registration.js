#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const util = require('util');
const { client: WebSocketClient } = require('websocket');

const DEFAULT_WS_URL = 'ws://localhost:8080/';
const WS_PROTOCOL = 'solid-stream-aggregator-protocol';
const ACTOR_WEBID = 'http://localhost:3000/alice/profile/card#me';
const { spawn } = require('child_process');
const QUERY = `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>
REGISTER RStream <output> AS
SELECT (AVG(?o) AS ?avg)
FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/spo2/> [RANGE 30000 STEP 30000]
WHERE {
  WINDOW :w1 {
    ?s saref:hasValue ?o .
  }
}`;
const RULES = `@prefix saref: <https://saref.etsi.org/core/> .
@prefix math: <http://www.w3.org/2000/10/swap/math#> .
@prefix ex: <http://example.org/> .

{ ?s saref:hasValue ?spo2Value . ?spo2Value math:lessThan 90. } => { ?s ex:alert "SPO2_LOW". }.
`;

function parseArgs(argv) {
  const out = {
    runs: 30,
    warmup: 5,
    timeoutMs: 120000,
    observeMs: 1000,
    outputDir: path.join(process.cwd(), 'benchmark-results'),
    wsUrl: DEFAULT_WS_URL,
    onAckCommand: null,
    onAckCwd: process.cwd(),
    onAckDelayMs: 0,
    targetMessageIndex: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--runs') out.runs = Number(next);
    if (key === '--warmup') out.warmup = Number(next);
    if (key === '--timeout-ms') out.timeoutMs = Number(next);
    if (key === '--observe-ms') out.observeMs = Number(next);
    if (key === '--output-dir') out.outputDir = path.resolve(next);
    if (key === '--ws-url') out.wsUrl = next;
    if (key === '--on-ack-command') out.onAckCommand = next;
    if (key === '--on-ack-cwd') out.onAckCwd = path.resolve(next);
    if (key === '--on-ack-delay-ms') out.onAckDelayMs = Number(next);
    if (key === '--target-message-index') out.targetMessageIndex = Number(next);
  }
  return out;
}

function nowNs() {
  return process.hrtime.bigint();
}

function nsDiffMs(startNs, endNs) {
  if (startNs == null || endNs == null) return null;
  return Number(endNs - startNs) / 1_000_000;
}

function parseServerNs(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function getMessageCorrelationId(message) {
  return message?.benchmark_timing?.correlation_id || null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function stats(values) {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / values.length;
  return {
    n: values.length,
    mean,
    stddev: Math.sqrt(variance),
    median: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function formatNumber(value) {
  return value == null ? 'n/a' : value.toFixed(3);
}

function printSummary(rows) {
  const metricNames = [
    'ws_connect_ms',
    'registration_send_to_ack_ms',
    'registration_send_to_first_message_ms',
    'registration_send_to_target_message_ms',
    'first_message_server_timestamp_to_client_receive_ms',
    'rsp_window_wait_ms',
    'rule_eval_ms',
    'uma_challenge_ms',
    'uma_token_exchange_ms',
    'uma_protected_get_ms',
    'total_uma_grant_ms',
    'total_client_observed_ms',
  ];
  console.log('\nMetric                              n    mean     stddev   median   p95      min      max');
  for (const metric of metricNames) {
    const values = rows.map((row) => row[metric]).filter((value) => typeof value === 'number' && Number.isFinite(value));
    const s = stats(values);
    if (!s) {
      console.log(`${metric.padEnd(34)} 0    n/a      n/a      n/a      n/a      n/a      n/a`);
      continue;
    }
    console.log(
      `${metric.padEnd(34)} ${String(s.n).padEnd(4)} ${formatNumber(s.mean).padEnd(8)} ${formatNumber(s.stddev).padEnd(8)} ${formatNumber(s.median).padEnd(8)} ${formatNumber(s.p95).padEnd(8)} ${formatNumber(s.min).padEnd(8)} ${formatNumber(s.max).padEnd(8)}`
    );
  }
}

function deriveMetrics(run) {
  const targetMessage = run.target_message || run.first_message;
  const timing = targetMessage?.benchmark_timing || run.ack?.benchmark_timing || {};
  const serverReceivedAtNs = parseServerNs(timing.server_received_at_ns);
  const queryRegisteredAtNs = parseServerNs(timing.query_registered_at_ns);
  const firstStreamEventAtNs = parseServerNs(timing.first_stream_event_at_ns);
  const rspWindowEvaluatedAtNs = parseServerNs(timing.rsp_window_evaluated_at_ns);
  const ruleEvalStartedAtNs = parseServerNs(timing.rule_eval_started_at_ns);
  const ruleEvalFinishedAtNs = parseServerNs(timing.rule_eval_finished_at_ns);
  const serverSentAtNs = parseServerNs(timing.server_sent_at_ns);
  const uma = timing.uma || {};
  return {
    ws_connect_ms: nsDiffMs(run.t_connect_start_ns, run.t_connected_ns),
    registration_send_to_ack_ms: run.t_ack_received_ns ? nsDiffMs(run.t_payload_sent_ns, run.t_ack_received_ns) : null,
    registration_send_to_first_message_ms: run.t_first_message_received_ns ? nsDiffMs(run.t_payload_sent_ns, run.t_first_message_received_ns) : null,
    registration_send_to_target_message_ms: run.t_target_message_received_ns ? nsDiffMs(run.t_payload_sent_ns, run.t_target_message_received_ns) : null,
    first_message_server_timestamp_to_client_receive_ms: serverSentAtNs && run.t_target_message_received_ns ? nsDiffMs(serverSentAtNs, run.t_target_message_received_ns) : null,
    rsp_window_wait_ms: queryRegisteredAtNs && rspWindowEvaluatedAtNs ? nsDiffMs(queryRegisteredAtNs, rspWindowEvaluatedAtNs) : null,
    first_stream_event_after_register_ms: queryRegisteredAtNs && firstStreamEventAtNs ? nsDiffMs(queryRegisteredAtNs, firstStreamEventAtNs) : null,
    rule_eval_ms: ruleEvalStartedAtNs && ruleEvalFinishedAtNs ? nsDiffMs(ruleEvalStartedAtNs, ruleEvalFinishedAtNs) : null,
    uma_challenge_ms: typeof uma.uma_challenge_ms === 'number' ? uma.uma_challenge_ms : null,
    uma_token_exchange_ms: typeof uma.uma_token_exchange_ms === 'number' ? uma.uma_token_exchange_ms : null,
    uma_protected_get_ms: typeof uma.uma_protected_get_ms === 'number' ? uma.uma_protected_get_ms : null,
    total_uma_grant_ms: typeof uma.total_uma_grant_ms === 'number' ? uma.total_uma_grant_ms : null,
    total_client_observed_ms: run.t_target_message_received_ns ? nsDiffMs(run.t_connect_start_ns, run.t_target_message_received_ns) : null,
    server_received_to_registered_ms: serverReceivedAtNs && queryRegisteredAtNs ? nsDiffMs(serverReceivedAtNs, queryRegisteredAtNs) : null,
    used_stored_token: uma.used_stored_token === true,
    used_cached_rpt: uma.used_cached_rpt === true,
    uma_resource: typeof uma.resource === 'string' ? uma.resource : null,
  };
}

function serializeRow(row) {
  const out = { ...row };
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'bigint') {
      out[key] = out[key].toString();
    }
  }
  return out;
}

function describeError(error) {
  if (!error) {
    return null;
  }
  const payload = {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: error.stack,
  };
  if (Array.isArray(error.errors)) {
    payload.errors = error.errors.map((child) => ({
      name: child?.name,
      message: child?.message,
      code: child?.code,
      errno: child?.errno,
      syscall: child?.syscall,
      address: child?.address,
      port: child?.port,
      stack: child?.stack,
    }));
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnCommand(command, cwd) {
  return spawn(command, {
    cwd,
    stdio: 'inherit',
    shell: true,
  });
}

async function runSingle(iteration, phase, opts, jsonlPath) {
  return new Promise((resolve) => {
    const c = new WebSocketClient();
    const correlationId = randomUUID();
    const result = {
      run_id: randomUUID(),
      correlation_id: correlationId,
      iteration,
      phase,
      ws_url: opts.wsUrl,
      protocol: WS_PROTOCOL,
      t_connect_start_ns: nowNs(),
      t_connected_ns: null,
      t_payload_sent_ns: null,
      t_ack_received_ns: null,
      t_first_message_received_ns: null,
      t_target_message_received_ns: null,
      ack: null,
      first_message: null,
      target_message: null,
      extra_message_count_after_first: 0,
      ignored_message_count: 0,
      matching_message_count: 0,
      status: 'pending',
      error: null,
    };

    let finished = false;
    let observationTimer = null;
    let ackCommandStarted = false;
    let ackChild = null;
    const timeout = setTimeout(() => finish('timeout', new Error(`Timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);

    const finish = (status, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (observationTimer) clearTimeout(observationTimer);
      result.status = status;
      result.error = error ? String(error.message || error) : null;
      result.error_detail = describeError(error);
      const derived = deriveMetrics(result);
      const row = {
        timestamp: new Date().toISOString(),
        ...result,
        ...derived,
      };
      fs.appendFileSync(jsonlPath, `${JSON.stringify(serializeRow(row))}\n`);
      try {
        c.abort();
      } catch (_) {
        // ignore
      }
      if (ackChild && !ackChild.killed) {
        ackChild.kill('SIGINT');
      }
      resolve(serializeRow(row));
    };

    const maybeStartAckCommand = async() => {
      if (ackCommandStarted || !opts.onAckCommand) {
        return;
      }
      ackCommandStarted = true;
      if (opts.onAckDelayMs > 0) {
        await sleep(opts.onAckDelayMs);
      }
      if (finished) {
        return;
      }
      ackChild = spawnCommand(opts.onAckCommand, opts.onAckCwd);
    };

    c.on('connectFailed', (error) => {
      console.error(`[connect_failed] ${util.inspect(describeError(error), { depth: 6, colors: false })}`);
      finish('connect_failed', error);
    });
    c.on('connect', (conn) => {
      result.t_connected_ns = nowNs();
      conn.on('error', (error) => finish('socket_error', error));
      conn.on('close', () => {
        if (!finished && result.first_message) finish('closed_after_first', null);
      });
      conn.on('message', (message) => {
        if (message.type !== 'utf8') return;
        let parsed;
        try {
          parsed = JSON.parse(message.utf8Data);
        } catch (_err) {
          parsed = { raw: message.utf8Data };
        }
        if (parsed.type === 'benchmark_ack') {
          if (!result.t_ack_received_ns) result.t_ack_received_ns = nowNs();
          result.ack = parsed;
          void maybeStartAckCommand();
          return;
        }
        const messageCorrelationId = getMessageCorrelationId(parsed);
        if (messageCorrelationId && messageCorrelationId !== correlationId) {
          result.ignored_message_count += 1;
          return;
        }
        result.matching_message_count += 1;
        if (!result.first_message) {
          result.t_first_message_received_ns = nowNs();
          result.first_message = parsed;
        }
        if (result.matching_message_count === opts.targetMessageIndex && !result.target_message) {
          result.t_target_message_received_ns = nowNs();
          result.target_message = parsed;
          observationTimer = setTimeout(() => finish('ok', null), opts.observeMs);
          return;
        }
        if (result.matching_message_count > 1) {
          result.extra_message_count_after_first += 1;
        }
      });

      const payload = {
        query: QUERY,
        rules: RULES,
        type: 'live',
        actor_webid: ACTOR_WEBID,
        correlation_id: correlationId,
      };
      result.t_payload_sent_ns = nowNs();
      conn.sendUTF(JSON.stringify(payload));
    });

    c.connect(opts.wsUrl, WS_PROTOCOL);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = path.join(opts.outputDir, `live-registration-benchmark-${runStamp}.jsonl`);

  const rows = [];
  for (let i = 0; i < opts.warmup; i += 1) {
    const row = await runSingle(i + 1, 'warmup', opts, jsonlPath);
    rows.push(row);
    console.log(`[warmup ${i + 1}/${opts.warmup}] status=${row.status} target_message_ms=${formatNumber(row.registration_send_to_target_message_ms)}`);
  }
  const measured = [];
  for (let i = 0; i < opts.runs; i += 1) {
    const row = await runSingle(i + 1, 'measured', opts, jsonlPath);
    rows.push(row);
    measured.push(row);
    console.log(`[run ${i + 1}/${opts.runs}] status=${row.status} target_message_ms=${formatNumber(row.registration_send_to_target_message_ms)} ack_ms=${formatNumber(row.registration_send_to_ack_ms)} matching_messages=${row.matching_message_count}`);
    await sleep(25);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    ws_url: opts.wsUrl,
    protocol: WS_PROTOCOL,
    jsonl_path: jsonlPath,
    warmup_runs: opts.warmup,
    measured_runs: opts.runs,
    successful_measured_runs: measured.filter((row) => row.status === 'ok').length,
    metrics: {},
  };

  const summaryMetrics = [
    'ws_connect_ms',
    'registration_send_to_ack_ms',
    'registration_send_to_first_message_ms',
    'registration_send_to_target_message_ms',
    'first_message_server_timestamp_to_client_receive_ms',
    'rsp_window_wait_ms',
    'rule_eval_ms',
    'uma_challenge_ms',
    'uma_token_exchange_ms',
    'uma_protected_get_ms',
    'total_uma_grant_ms',
    'total_client_observed_ms',
  ];
  for (const metric of summaryMetrics) {
    const values = measured
      .map((row) => row[metric])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    summary.metrics[metric] = stats(values);
  }

  const summaryPath = path.join(opts.outputDir, `live-registration-benchmark-${runStamp}.summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nJSONL: ${jsonlPath}`);
  console.log(`Summary: ${summaryPath}`);
  printSummary(measured.filter((row) => row.status === 'ok'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
