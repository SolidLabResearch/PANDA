#!/usr/bin/env node
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');

const CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';
const DEFAULT_CLAIM_TOKEN = 'http://localhost:3000/alice/profile/card#me';
const SPO2_PROPERTY = 'https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2';

function parseArgs(argv) {
  const out = {
    url: 'http://localhost:3000/alice/spo2/',
    durationSeconds: 120,
    intervalMs: 1000,
    benchmarkRunId: randomUUID(),
    pandaWebhookUrl: 'http://localhost:8080/',
    claimToken: process.env.PANDA_REPLAYER_CLAIM_TOKEN || DEFAULT_CLAIM_TOKEN,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--url') out.url = next;
    if (key === '--duration') out.durationSeconds = Number(next);
    if (key === '--interval-ms') out.intervalMs = Number(next);
    if (key === '--benchmark-run-id') out.benchmarkRunId = next;
    if (key === '--panda-webhook-url') out.pandaWebhookUrl = next;
    if (key === '--claim-token') out.claimToken = next;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAuthenticateHeader(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) {
    throw new Error('Missing WWW-Authenticate header');
  }
  const headerWithoutScheme = wwwAuthenticateHeader.replace(/^UMA\s+/i, '');
  const params = Object.fromEntries(headerWithoutScheme.split(/\s*,\s*/).map((param) => {
    const separatorIndex = param.indexOf('=');
    if (separatorIndex < 0) return [param.trim(), ''];
    return [
      param.slice(0, separatorIndex).trim(),
      param.slice(separatorIndex + 1).trim().replace(/^"|"$/g, ''),
    ];
  }));
  if (!params.as_uri || !params.ticket) {
    throw new Error(`Invalid UMA challenge: ${wwwAuthenticateHeader}`);
  }
  const tokenEndpoint = new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString();
  return { tokenEndpoint, ticket: params.ticket };
}

async function exchangeToken(tokenEndpoint, ticket, claimToken) {
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
  if (!response.ok) {
    throw new Error(`UMA token exchange failed status=${response.status} body=${body}`);
  }
  return JSON.parse(body);
}

function makeObservation(runId, index) {
  const id = `http://example.org/panda-benchmark/${runId}/spo2/${index}`;
  const value = 88 + (index % 10);
  const timestamp = new Date().toISOString();
  return [
    `<${id}> <https://saref.etsi.org/core/measurementMadeBy> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/PANDA.SPO2> .`,
    `<${id}> <https://saref.etsi.org/core/relatesToProperty> <${SPO2_PROPERTY}> .`,
    `<${id}> <https://saref.etsi.org/core/hasTimestamp> "${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
    `<${id}> <https://saref.etsi.org/core/hasValue> "${value}"^^<http://www.w3.org/2001/XMLSchema#float> .`,
    '',
  ].join('\n');
}

async function authorizedPost(url, body, token) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`,
    },
    body,
  });
}

async function postWithUma(url, body, state) {
  const totalStartedAt = performance.now();
  const headers = {
    'Content-Type': 'text/turtle',
  };
  if (state.token) {
    headers.Authorization = `${state.token.token_type || 'Bearer'} ${state.token.access_token}`;
  }
  const challengeStartedAt = performance.now();
  let response = await fetch(url, { method: 'POST', headers, body });
  const challengeMs = performance.now() - challengeStartedAt;
  if (response.ok) {
    return {
      status: response.status,
      location: response.headers.get('Location') || response.headers.get('location') || '',
      umaChallengeObserved: false,
      challengeMs,
      tokenExchangeMs: null,
      authorizedRequestMs: challengeMs,
      totalMs: performance.now() - totalStartedAt,
    };
  }
  if (response.status !== 401 && response.status !== 403) {
    const text = await response.text().catch(() => '');
    throw new Error(`POST failed status=${response.status} body=${text}`);
  }
  const challenge = parseAuthenticateHeader(response.headers.get('WWW-Authenticate'));
  const tokenStartedAt = performance.now();
  state.token = await exchangeToken(challenge.tokenEndpoint, challenge.ticket, state.claimToken);
  const tokenExchangeMs = performance.now() - tokenStartedAt;
  const authorizedStartedAt = performance.now();
  response = await authorizedPost(url, body, state.token);
  const authorizedRequestMs = performance.now() - authorizedStartedAt;
  if ((response.status === 401 || response.status === 403) && state.token) {
    state.token = null;
    const text = await response.text().catch(() => '');
    console.warn(`[BENCHMARK_REPLAYER] authorized_retry_invalidated status=${response.status} body=${text}`);
    return postWithUma(url, body, state);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Authorized POST failed status=${response.status} body=${text}`);
  }
  return {
    status: response.status,
    location: response.headers.get('Location') || response.headers.get('location') || '',
    umaChallengeObserved: true,
    challengeMs,
    tokenExchangeMs,
    authorizedRequestMs,
    totalMs: performance.now() - totalStartedAt,
  };
}

async function notifyPanda(pandaWebhookUrl, topic, target, runId, count, data) {
  if (!pandaWebhookUrl) return;
  const response = await fetch(pandaWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'Add',
      topic,
      target,
      benchmark_run_id: runId,
      count,
      data,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`PANDA webhook notify failed status=${response.status} body=${body}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const state = { token: null, claimToken: opts.claimToken };
  const startedAt = performance.now();
  const startedAtWall = new Date().toISOString();
  const deadline = startedAt + opts.durationSeconds * 1000;
  let posted = 0;

  console.log(`[BENCHMARK_REPLAYER] started benchmark_run_id=${opts.benchmarkRunId} url=${opts.url} duration_seconds=${opts.durationSeconds} started_at=${startedAtWall}`);
  while (performance.now() < deadline) {
    const eventStartedAt = performance.now();
    const payload = makeObservation(opts.benchmarkRunId, posted + 1);
    const postResult = await postWithUma(opts.url, payload, state);
    posted += 1;
    const target = postResult.location ? new URL(postResult.location, opts.url).toString() : opts.url;
    await notifyPanda(opts.pandaWebhookUrl, opts.url, target, opts.benchmarkRunId, posted, payload);
    console.log(`[BENCHMARK_REPLAYER] event_posted benchmark_run_id=${opts.benchmarkRunId} count=${posted} status=${postResult.status} target=${target} uma_challenge_observed=${postResult.umaChallengeObserved} challenge_ms=${postResult.challengeMs.toFixed(3)} token_exchange_ms=${postResult.tokenExchangeMs === null ? 'null' : postResult.tokenExchangeMs.toFixed(3)} authorized_request_ms=${postResult.authorizedRequestMs.toFixed(3)} total_ms=${postResult.totalMs.toFixed(3)} timestamp=${new Date().toISOString()}`);
    const elapsed = performance.now() - eventStartedAt;
    await sleep(Math.max(0, opts.intervalMs - elapsed));
  }
  const runtimeMs = performance.now() - startedAt;
  console.log(`[BENCHMARK_REPLAYER] completed benchmark_run_id=${opts.benchmarkRunId} events_posted=${posted} runtime_ms=${runtimeMs.toFixed(3)} completed_at=${new Date().toISOString()}`);
}

main().catch((error) => {
  console.error(`[BENCHMARK_REPLAYER] failed error=${error?.stack || error}`);
  process.exit(1);
});
