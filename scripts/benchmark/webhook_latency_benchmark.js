#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { client: WebSocketClient } = require('websocket');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function assertReachable(url, label) {
  try {
    const response = await fetch(url, { method: 'GET' });
    return { ok: true, status: response.status };
  } catch (error) {
    throw new Error(`${label} not reachable at ${url}: ${error.message}`);
  }
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

async function postText(url, body, contentType = 'text/turtle') {
  return postTextWithHeaders(url, body, { 'Content-Type': contentType });
}

async function postTextWithHeaders(url, body, headers) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });
  const text = await response.text().catch(() => '');
  return { response, body: text };
}

function parseAuthenticateHeader(header) {
  if (!header || !/^UMA\s+/i.test(header)) {
    throw new Error(`Expected UMA challenge, got: ${header || '<empty>'}`);
  }
  const params = Object.fromEntries(
    header.replace(/^UMA\s+/i, '').split(/\s*,\s*/).map((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return [part.trim(), ''];
      return [part.slice(0, idx).trim(), part.slice(idx + 1).trim().replace(/^"|"$/g, '')];
    }),
  );
  if (!params.as_uri || !params.ticket) {
    throw new Error(`Invalid UMA challenge: ${header}`);
  }
  const tokenEndpoint = new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString();
  return { ticket: params.ticket, tokenEndpoint };
}

async function exchangeUmaToken(tokenEndpoint, ticket, claimToken, claimTokenFormat) {
  const payload = {
    grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
    ticket,
    // UMA "webid" format expects encodeURIComponent(webId)[:encodeURIComponent(clientId)].
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
  try { json = JSON.parse(raw); } catch {}
  if (response.status !== 200 || !json?.access_token) {
    throw new Error(`Token exchange failed (${response.status}): ${raw}`);
  }
  return { tokenType: json.token_type || 'Bearer', accessToken: json.access_token };
}

async function getUmaTokenForPost(url, claimToken, claimTokenFormat) {
  const challengeResponse = await fetch(url, { method: 'POST' });
  if (challengeResponse.status !== 401) {
    const body = await challengeResponse.text().catch(() => '');
    throw new Error(`Expected 401 UMA challenge for POST ${url}, got ${challengeResponse.status}: ${body}`);
  }
  const parsed = parseAuthenticateHeader(challengeResponse.headers.get('WWW-Authenticate') || '');
  return exchangeUmaToken(parsed.tokenEndpoint, parsed.ticket, claimToken, claimTokenFormat);
}

function parseJsonSafe(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractSubscriptionLocation(response, body, fallbackUrl) {
  const location = response.headers.get('location') || response.headers.get('Location');
  if (location) {
    try {
      return new URL(location, fallbackUrl).toString();
    } catch {
      return location;
    }
  }
  const parsed = parseJsonSafe(body);
  if (parsed && typeof parsed.id === 'string' && parsed.id.trim().length > 0) {
    try {
      return new URL(parsed.id, fallbackUrl).toString();
    } catch {
      return parsed.id;
    }
  }
  return null;
}

function buildWebhookSubscriptionJsonLd(topic, sendTo) {
  return JSON.stringify({
    '@context': ['https://www.w3.org/ns/solid/notification/v1'],
    type: 'http://www.w3.org/ns/solid/notifications#WebhookChannel2023',
    topic,
    sendTo,
  });
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

async function waitForLogMarkers({ logFile, cursor, requiredMarkers, timeoutMs = 10000, pollMs = 200 }) {
  const foundAt = {};
  let currentCursor = cursor;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const { nextCursor, lines } = readNewLines(logFile, currentCursor);
    currentCursor = nextCursor;

    for (const line of lines) {
      for (const marker of requiredMarkers) {
        if (!foundAt[marker] && line.includes(marker)) {
          foundAt[marker] = new Date().toISOString();
        }
      }
    }

    const missing = requiredMarkers.filter((marker) => !foundAt[marker]);
    if (missing.length === 0) {
      return { ok: true, foundAt, nextCursor: currentCursor, missing: [] };
    }
    await sleep(pollMs);
  }

  return {
    ok: false,
    foundAt,
    nextCursor: currentCursor,
    missing: requiredMarkers.filter((marker) => !foundAt[marker]),
  };
}

function buildMemberTurtle(memberUrl, valueLiteral, timestampIso = new Date()) {
  const timestamp = normalizeTimestamp(timestampIso);
  return [
    `<${memberUrl}> <https://saref.etsi.org/core/hasValue> "${valueLiteral}"^^<http://www.w3.org/2001/XMLSchema#decimal> .`,
    `<${memberUrl}> <https://saref.etsi.org/core/relatesToProperty> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2> .`,
    `<${memberUrl}> <https://saref.etsi.org/core/hasTimestamp> "${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
    '',
  ].join('\n');
}

async function main() {
  const cwd = process.cwd();
  const wsUrl = env('AGG_WS_URL', 'ws://localhost:8080/');
  const replayPostUrl = env('REPLAY_POST_URL', 'http://localhost:3000/alice/acc-x/');
  const notificationChannelUrl = env('NOTIFICATION_CHANNEL_URL', 'http://localhost:3000/.notifications/WebhookChannel2023/');
  const notificationTopic = env('NOTIFICATION_TOPIC', 'http://localhost:3000/alice/acc-x/');
  const notificationSendTo = env('NOTIFICATION_SEND_TO', 'http://localhost:8080/');
  const logFile = env('PANDA_MONITOR_LOG_FILE', findLatestPandaLog(cwd));
  const sanityTimeoutMs = Number(env('SANITY_TIMEOUT_MS', '15000'));
  const queryFile = env('QUERY_FILE', path.join(process.cwd(), 'benchmark.query.rspql'));
  const rulesFile = env('RULES_FILE', '');
  const queryType = env('QUERY_TYPE', 'live');
  const warmupIterations = Number(env('WARMUP_ITERATIONS', '3'));
  const iterations = Number(env('ITERATIONS', '30'));
  const interIterationDelayMs = Number(env('INTER_ITERATION_DELAY_MS', '250'));
  const outputDir = env('OUTPUT_DIR', path.join(process.cwd(), 'benchmark-results'));
  const outputPrefix = env('OUTPUT_PREFIX', 'webhook-latency');
  const claimToken = env('CLAIM_TOKEN', 'http://localhost:3000/alice/profile/card#me');
  const claimTokenFormat = env('CLAIM_TOKEN_FORMAT', 'urn:solidlab:uma:claims:formats:webid');

  if (!fs.existsSync(queryFile)) {
    throw new Error(`Missing QUERY_FILE: ${queryFile}`);
  }
  if (!logFile || !fs.existsSync(logFile)) {
    throw new Error(`Missing PANDA monitor log file. Set PANDA_MONITOR_LOG_FILE explicitly. Current value: ${logFile || '<empty>'}`);
  }

  const query = await readText(queryFile);
  const rules = rulesFile && fs.existsSync(rulesFile) ? await readText(rulesFile) : '';

  console.log('[endpoint-preflight]');
  console.log(JSON.stringify({
    wsUrl,
    replayPostUrl,
    notificationChannelUrl,
    notificationTopic,
    notificationSendTo,
  }, null, 2));

  await assertReachable('http://localhost:8080/', 'PANDA aggregator');
  await assertReachable('http://localhost:3000/', 'CSS');
  const replayPostToken = await getUmaTokenForPost(replayPostUrl, claimToken, claimTokenFormat);

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

  const subscriptionPayload = buildWebhookSubscriptionJsonLd(notificationTopic, notificationSendTo);
  const preflight = await postText(notificationChannelUrl, subscriptionPayload, 'application/ld+json');
  const subscriptionLocation = extractSubscriptionLocation(preflight.response, preflight.body, notificationChannelUrl);
  const registrationStatusOk = preflight.response.status === 200 || preflight.response.status === 201;
  const webhookRegistration = {
    url: notificationChannelUrl,
    content_type: 'application/ld+json',
    request: subscriptionPayload,
    status: preflight.response.status,
    ok: registrationStatusOk && Boolean(subscriptionLocation),
    subscription: subscriptionLocation,
    body: preflight.body,
  };
  console.log('[webhook-registration]');
  console.log(JSON.stringify(webhookRegistration, null, 2));
  if (!registrationStatusOk || !subscriptionLocation) {
    throw new Error(`Webhook preflight registration failed (status=${preflight.response.status}, has_subscription_ref=${Boolean(subscriptionLocation)}). body=${preflight.body}`);
  }

  await sleep(1000);

  const requiredMarkers = [
    'webhook_notification_data_received',
    'webhook_notification_received',
    'webhook_notification_emitting_topic',
    '[MEASURE][INGEST]',
    '[MEASURE][RSP]',
  ];
  const initialCursor = fs.statSync(logFile).size;
  const sanityMemberUrl = `${notificationTopic.replace(/\/$/, '')}/${randomUUID()}`;
  const sanityTimestamp = normalizeTimestamp(new Date());
  const sanityTurtle = buildMemberTurtle(sanityMemberUrl, '81', sanityTimestamp);
  const sanityWsPromise = new Promise(resolve => {
    pending.push({ resolve });
  });
  const sanityPostStart = Date.now();
  const sanityWrite = await postTextWithHeaders(replayPostUrl, sanityTurtle, {
    'Content-Type': 'text/turtle',
    Authorization: `${replayPostToken.tokenType} ${replayPostToken.accessToken}`,
  });
  const sanityPostDone = Date.now();
  if (!(sanityWrite.response.status === 201 || sanityWrite.response.status === 200)) {
    throw new Error(`Sanity POST failed with ${sanityWrite.response.status}: ${sanityWrite.body}`);
  }
  const sanityWs = await sanityWsPromise;
  const sanityProof = await waitForLogMarkers({
    logFile,
    cursor: initialCursor,
    requiredMarkers,
    timeoutMs: sanityTimeoutMs,
  });
  const sanityNotificationProof = {
    replay_post_url: replayPostUrl,
    posted_member: sanityMemberUrl,
    post_status: sanityWrite.response.status,
    post_location: sanityWrite.response.headers.get('location') || null,
    post_ack_latency_ms: sanityPostDone - sanityPostStart,
    ws_received_ms: sanityWs.receivedAtMs,
    log_file: logFile,
    markers_found: sanityProof.foundAt,
    markers_missing: sanityProof.missing,
  };
  console.log('[sanity-notification-proof]');
  console.log(JSON.stringify(sanityNotificationProof, null, 2));
  if (!sanityProof.ok) {
    throw new Error(`Sanity notification failed. Missing log markers: ${sanityProof.missing.join(', ')}`);
  }

  const totalIterations = warmupIterations + iterations;

  for (let index = 0; index < totalIterations; index += 1) {
    const memberUrl = `${notificationTopic.replace(/\/$/, '')}/${randomUUID()}`;
    const memberTimestamp = normalizeTimestamp(new Date());
    const memberTurtle = buildMemberTurtle(memberUrl, String(82 + (index % 10)), memberTimestamp);

    const label = index < warmupIterations ? 'warmup' : 'measured';
    const startMs = Date.now();

    const wsPromise = new Promise(resolve => {
      pending.push({ resolve });
    });

    const { response, body } = await postTextWithHeaders(replayPostUrl, memberTurtle, {
      'Content-Type': 'text/turtle',
      Authorization: `${replayPostToken.tokenType} ${replayPostToken.accessToken}`,
    });
    const postDoneMs = Date.now();

    if (!(response.status === 201 || response.status === 200)) {
      throw new Error(`Replay POST failed with ${response.status}: ${body}`);
    }

    const wsResult = await wsPromise;
    const endToEndMs = wsResult.receivedAtMs - startMs;
    const postAckMs = postDoneMs - startMs;

    const row = {
      iteration: index + 1,
      phase: label,
      target: memberUrl,
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
    replay_post_url: replayPostUrl,
    notification_channel_url: notificationChannelUrl,
    notification_topic: notificationTopic,
    notification_send_to: notificationSendTo,
    query_file: queryFile,
    rules_file: rulesFile || null,
    panda_monitor_log_file: logFile,
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

  console.log('[benchmark-raw-rows]');
  console.log(JSON.stringify(results, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  connection.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
