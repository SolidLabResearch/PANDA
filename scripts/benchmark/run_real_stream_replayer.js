#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { randomUUID } = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');
const DEFAULT_CLAIM_TOKEN = 'http://localhost:3000/alice/profile/card#me';
const CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';

function parseArgs(argv) {
  const out = {
    targetUrl: 'http://localhost:3000/alice/spo2/',
    datasetRelativePath: 'benchmarks/generated/heart-rate-ibi-real-10min.nt',
    durationSeconds: 120,
    intervalMs: null,
    benchmarkRunId: randomUUID(),
    rawDir: null,
    claimToken: process.env.PANDA_REPLAYER_CLAIM_TOKEN || DEFAULT_CLAIM_TOKEN,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = argv[index + 1];
    if (key === '--target-url') out.targetUrl = next;
    if (key === '--dataset-relative-path') out.datasetRelativePath = next;
    if (key === '--duration') out.durationSeconds = Number(next);
    if (key === '--interval-ms') out.intervalMs = Number(next);
    if (key === '--benchmark-run-id') out.benchmarkRunId = next;
    if (key === '--raw-dir') out.rawDir = next;
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

function groupObservations(ntText) {
  const observations = [];
  let currentSubject = null;
  let currentLines = [];
  for (const rawLine of ntText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const subjectMatch = line.match(/^<([^>]+)>\s+/);
    if (!subjectMatch) continue;
    const subject = subjectMatch[1];
    if (currentSubject && subject !== currentSubject && currentLines.length > 0) {
      observations.push({ subject: currentSubject, lines: currentLines.slice() });
      currentLines = [];
    }
    currentSubject = subject;
    currentLines.push(line);
  }
  if (currentSubject && currentLines.length > 0) {
    observations.push({ subject: currentSubject, lines: currentLines.slice() });
  }
  return observations;
}

function extractObservationMetadata(lines) {
  const timestampLine = lines.find((line) => line.includes('hasTimestamp')) || '';
  const valueLine = lines.find((line) => line.includes('hasValue')) || '';
  const timestampMatch = timestampLine.match(/"([^"]+)"\^\^/);
  const valueMatch = valueLine.match(/"([^"]+)"\^\^/);
  return {
    timestamp: timestampMatch ? timestampMatch[1] : null,
    value: valueMatch ? Number(valueMatch[1]) : null,
  };
}

async function postWithUma(url, body, state) {
  const headers = { 'Content-Type': 'text/turtle' };
  if (state.token) {
    headers.Authorization = `${state.token.token_type || 'Bearer'} ${state.token.access_token}`;
  }
  let response = await fetch(url, { method: 'POST', headers, body });
  if (response.ok) {
    return { status: response.status, location: response.headers.get('Location') || response.headers.get('location') || '' };
  }
  if (response.status !== 401 && response.status !== 403) {
    const text = await response.text().catch(() => '');
    throw new Error(`POST failed status=${response.status} body=${text}`);
  }
  const challenge = parseAuthenticateHeader(response.headers.get('WWW-Authenticate'));
  state.token = await exchangeToken(challenge.tokenEndpoint, challenge.ticket, state.claimToken);
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      Authorization: `${state.token.token_type || 'Bearer'} ${state.token.access_token}`,
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Authorized POST failed status=${response.status} body=${text}`);
  }
  return { status: response.status, location: response.headers.get('Location') || response.headers.get('location') || '' };
}

function writeMetadata(rawDir, benchmarkRunId, metadata) {
  if (!rawDir) return null;
  fs.mkdirSync(rawDir, { recursive: true });
  const filePath = path.join(rawDir, `real-replayer-metadata-${benchmarkRunId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(metadata, null, 2)}\n`);
  return filePath;
}

function resolveDatasetPath(datasetRelativePath) {
  const candidates = [];
  if (path.isAbsolute(datasetRelativePath)) {
    candidates.push(datasetRelativePath);
  } else {
    candidates.push(path.join(REPO_ROOT, datasetRelativePath));
    candidates.push(path.join(WORKSPACE_ROOT, 'policy-aware-decentralized-stream-replayer', datasetRelativePath.replace(/^\.\//, '')));
    candidates.push(path.join(WORKSPACE_ROOT, 'policy-aware-decentralized-stream-replayer', 'data', path.basename(datasetRelativePath)));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const datasetPath = resolveDatasetPath(opts.datasetRelativePath);
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Real replayer dataset not found at ${datasetPath}`);
  }

  const ntText = fs.readFileSync(datasetPath, 'utf8');
  const observations = groupObservations(ntText);
  if (observations.length === 0) {
    throw new Error(`No observations were found in ${datasetPath}`);
  }

  const startedAtPerf = performance.now();
  const startedAtWall = new Date().toISOString();
  const deadline = startedAtPerf + opts.durationSeconds * 1000;
  const state = { token: null, claimToken: opts.claimToken };

  const metadata = {
    benchmark_run_id: opts.benchmarkRunId,
    replayer_repo_dir: REPO_ROOT,
    dataset_path: datasetPath,
    target_url: opts.targetUrl,
    duration_seconds: opts.durationSeconds,
    observation_count: observations.length,
    computed_frequency_hz: observations.length / Math.max(1, opts.durationSeconds),
    invocation: {
      command: 'node',
      args: ['scripts/benchmark/run_real_stream_replayer.js'],
    },
    claim_token_format: CLAIM_TOKEN_FORMAT,
    claim_token_supplied: Boolean(opts.claimToken),
    fake_replayer_used: false,
  };
  const metadataPath = writeMetadata(opts.rawDir, opts.benchmarkRunId, metadata);

  console.log(`[BENCHMARK_REPLAYER] started benchmark_run_id=${opts.benchmarkRunId} url=${opts.targetUrl} duration_seconds=${opts.durationSeconds} dataset_path=${datasetPath} observations=${observations.length} started_at=${startedAtWall}`);
  if (metadataPath) {
    console.log(`[BENCHMARK_REPLAYER] provenance_written benchmark_run_id=${opts.benchmarkRunId} file=${metadataPath}`);
  }

  let posted = 0;
  let previousTimestampMs = null;
  for (let index = 0; index < observations.length && performance.now() < deadline; index += 1) {
    const observation = observations[index];
    const { timestamp, value } = extractObservationMetadata(observation.lines);
    if (timestamp) {
      const currentTimestampMs = Date.parse(timestamp);
      if (previousTimestampMs != null && Number.isFinite(currentTimestampMs)) {
        const delayMs = currentTimestampMs - previousTimestampMs;
        if (delayMs > 0) {
          await sleep(Math.min(delayMs, Math.max(0, deadline - performance.now())));
        }
      }
      if (Number.isFinite(currentTimestampMs)) {
        previousTimestampMs = currentTimestampMs;
      }
    }

    const eventStartedAt = performance.now();
    const postResult = await postWithUma(opts.targetUrl, `${observation.lines.join('\n')}\n`, state);
    posted += 1;
    const elapsed = performance.now() - eventStartedAt;
    console.log(
      `[BENCHMARK_REPLAYER] event_posted benchmark_run_id=${opts.benchmarkRunId} event_index=${index + 1} count=${posted} status=${postResult.status} post_duration_ms=${elapsed.toFixed(3)} target=${postResult.location ? new URL(postResult.location, opts.targetUrl).toString() : opts.targetUrl} timestamp=${new Date().toISOString()} event_timestamp_value=${timestamp || 'null'} event_value=${value === null || Number.isNaN(value) ? 'null' : value} is_elevated_heart_rate=${typeof value === 'number' ? value >= 99.9 : false}`,
    );
  }

  const remainingMs = deadline - performance.now();
  if (remainingMs > 0) {
    await sleep(remainingMs);
  }

  const runtimeMs = performance.now() - startedAtPerf;
  console.log(`[BENCHMARK_REPLAYER] completed benchmark_run_id=${opts.benchmarkRunId} events_posted=${posted} runtime_ms=${runtimeMs.toFixed(3)} completed_at=${new Date().toISOString()}`);
}

main().catch((error) => {
  console.error(`[BENCHMARK_REPLAYER] failed error=${error?.stack || error}`);
  process.exit(1);
});