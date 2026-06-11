#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { client: WebSocketClient } = require('websocket');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return NaN;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function mean(values) {
  if (values.length === 0) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function readText(filePath) {
  return fs.promises.readFile(filePath, 'utf8');
}

async function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const wsClient = new WebSocketClient();

    wsClient.on('connectFailed', reject);
    wsClient.on('connect', connection => resolve({ wsClient, connection }));
    wsClient.connect(url, 'solid-stream-aggregator-protocol');
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.text().catch(() => '');
  return { response, body };
}

async function main() {
  const wsUrl = env('AGG_WS_URL', 'ws://localhost:8080/');
  const httpUrl = env('AGG_HTTP_URL', 'http://localhost:8080/');
  const queryFile = env('QUERY_FILE', path.join(process.cwd(), 'benchmark.query.rspql'));
  const rulesFile = env('RULES_FILE', '');
  const targetsFile = env('TARGETS_FILE', path.join(process.cwd(), 'benchmark.targets.txt'));
  const queryType = env('QUERY_TYPE', 'live');
  const warmupIterations = Number(env('WARMUP_ITERATIONS', '3'));
  const iterations = Number(env('ITERATIONS', '30'));
  const interIterationDelayMs = Number(env('INTER_ITERATION_DELAY_MS', '250'));
  const outputDir = env('OUTPUT_DIR', path.join(process.cwd(), 'benchmark-results'));
  const outputPrefix = env('OUTPUT_PREFIX', 'webhook-latency');

  if (!fs.existsSync(queryFile)) {
    throw new Error(`Missing QUERY_FILE: ${queryFile}`);
  }
  if (!fs.existsSync(targetsFile)) {
    throw new Error(`Missing TARGETS_FILE: ${targetsFile}`);
  }

  const query = await readText(queryFile);
  const rules = rulesFile && fs.existsSync(rulesFile) ? await readText(rulesFile) : '';
  const targets = (await readText(targetsFile))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    throw new Error(`No targets found in ${targetsFile}`);
  }

  await fs.promises.mkdir(outputDir, { recursive: true });

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = path.join(outputDir, `${outputPrefix}-${runId}.csv`);
  const summaryPath = path.join(outputDir, `${outputPrefix}-${runId}.summary.json`);

  const { connection } = await connectWebSocket(wsUrl);
  const pending = [];
  const results = [];

  connection.on('message', message => {
    if (message.type !== 'utf8') return;
    const now = Date.now();
    const pendingItem = pending.shift();
    if (!pendingItem) return;

    let parsed = message.utf8Data;
    try {
      parsed = JSON.parse(message.utf8Data);
    } catch (_) {
      // leave as raw string
    }

    pendingItem.resolve({
      receivedAtMs: now,
      payload: parsed,
    });
  });

  connection.sendUTF(JSON.stringify({
    query,
    rules,
    type: queryType,
  }));

  await sleep(1000);

  const totalIterations = warmupIterations + iterations;

  for (let index = 0; index < totalIterations; index += 1) {
    const target = targets[index % targets.length];
    const webhookPayload = {
      type: 'Add',
      target,
    };

    const label = index < warmupIterations ? 'warmup' : 'measured';
    const startMs = Date.now();

    const wsPromise = new Promise(resolve => {
      pending.push({ resolve });
    });

    const { response, body } = await postJson(httpUrl, webhookPayload);
    const postDoneMs = Date.now();

    if (!response.ok) {
      throw new Error(`HTTP POST failed with ${response.status}: ${body}`);
    }

    const wsResult = await wsPromise;
    const endToEndMs = wsResult.receivedAtMs - startMs;
    const postAckMs = postDoneMs - startMs;

    const row = {
      iteration: index + 1,
      phase: label,
      target,
      start_ms: startMs,
      post_done_ms: postDoneMs,
      ws_received_ms: wsResult.receivedAtMs,
      post_ack_latency_ms: postAckMs,
      end_to_end_latency_ms: endToEndMs,
    };

    results.push(row);
    await sleep(interIterationDelayMs);
  }

  const measured = results.filter(row => row.phase === 'measured');
  const e2eValues = measured.map(row => row.end_to_end_latency_ms).sort((a, b) => a - b);
  const ackValues = measured.map(row => row.post_ack_latency_ms).sort((a, b) => a - b);

  const wallClockMs = measured.length > 0
    ? measured[measured.length - 1].ws_received_ms - measured[0].start_ms
    : 0;

  const summary = {
    run_id: runId,
    ws_url: wsUrl,
    http_url: httpUrl,
    query_file: queryFile,
    rules_file: rulesFile || null,
    targets_file: targetsFile,
    query_type: queryType,
    warmup_iterations: warmupIterations,
    measured_iterations: iterations,
    avg_end_to_end_latency_ms: mean(e2eValues),
    p95_end_to_end_latency_ms: percentile(e2eValues, 95),
    avg_post_ack_latency_ms: mean(ackValues),
    p95_post_ack_latency_ms: percentile(ackValues, 95),
    throughput_events_per_sec: wallClockMs > 0 ? (measured.length / wallClockMs) * 1000 : null,
    csv_path: csvPath,
  };

  const csvHeader = [
    'iteration',
    'phase',
    'target',
    'start_ms',
    'post_done_ms',
    'ws_received_ms',
    'post_ack_latency_ms',
    'end_to_end_latency_ms',
  ].join(',');

  const csvRows = results.map(row => [
    row.iteration,
    row.phase,
    JSON.stringify(row.target),
    row.start_ms,
    row.post_done_ms,
    row.ws_received_ms,
    row.post_ack_latency_ms,
    row.end_to_end_latency_ms,
  ].join(','));

  await fs.promises.writeFile(csvPath, `${csvHeader}\n${csvRows.join('\n')}\n`);
  await fs.promises.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(JSON.stringify(summary, null, 2));
  connection.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
