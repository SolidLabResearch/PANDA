#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseArgs(argv) {
  const out = { runs: Number(env('RUNS', '1')), warmup: Number(env('WARMUP', '0')), benchmarkId: env('BENCHMARK_ID', '') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runs') out.runs = Number(argv[i + 1]);
    if (argv[i] === '--warmup') out.warmup = Number(argv[i + 1]);
    if (argv[i] === '--benchmark-id') out.benchmarkId = argv[i + 1];
  }
  if (!Number.isFinite(out.runs) || out.runs < 1) throw new Error('--runs must be >= 1');
  if (!Number.isFinite(out.warmup) || out.warmup < 0) throw new Error('--warmup must be >= 0');
  return out;
}

function runNode(script, extraArgs, benchmarkId) {
  const cmd = [script, ...extraArgs, '--benchmark-id', benchmarkId];
  const res = spawnSync('node', cmd, { cwd: ROOT, encoding: 'utf8', env: process.env, maxBuffer: 100 * 1024 * 1024 });
  if (res.status !== 0) return { ok: false, stdout: res.stdout, stderr: res.stderr };
  try {
    const json = JSON.parse((res.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0]);
    return { ok: true, json, stdout: res.stdout, stderr: res.stderr };
  } catch {
    return { ok: false, stdout: res.stdout, stderr: res.stderr };
  }
}

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.benchmarkId || new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(ROOT, 'benchmark-results', `protected-alert-lifecycle-simple-${runId}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const runsPath = path.join(outputDir, `protected-alert-lifecycle-simple-${runId}.runs.jsonl`);
  const summaryPath = path.join(outputDir, `protected-alert-lifecycle-simple-${runId}.summary.json`);

  const rows = [];
  let firstFailure = null;
  const total = args.warmup + args.runs;
  for (let i = 0; i < total; i += 1) {
    const phase = i < args.warmup ? 'warmup' : 'measured';
    const n = phase === 'warmup' ? i + 1 : i - args.warmup + 1;
    const iterId = `${runId}-${phase}-${n}`;
    const row = { benchmark_name: 'protected-alert-lifecycle-simple', run_id: runId, phase, iteration: n, status: 'failed', outcome: 'failed' };

    const a = runNode('scripts/benchmark/alert_materialization_benchmark.js', [], `${iterId}-phase-a`);
    if (!a.ok || a.json.status !== 'ok') {
      row.phase_a = a.json || null;
      row.error = a.json?.failure_reason || (a.stderr || a.stdout || 'Phase A failed').slice(0, 500);
      rows.push(row);
      fs.appendFileSync(runsPath, `${JSON.stringify(row)}\n`);
      firstFailure = firstFailure || new Error(row.error);
      continue;
    }

    row.benchmark_run_id = a.json.benchmark_run_id;
    row.alert_target = a.json.alert_target_url;
    row.alert_materialized = a.json.alert_materialized;
    row.alert_contains_current_benchmark_run_id = a.json.alert_contains_current_benchmark_run_id;

    const b = runNode('scripts/benchmark/protected_alert_access_simple_benchmark.js', ['--alert-target', row.alert_target, '--benchmark-run-id', row.benchmark_run_id], `${iterId}-phase-b`);
    row.phase_a = a.json;
    row.phase_b = b.json || null;
    if (!b.ok || b.json.status !== 'ok') {
      row.error = b.json?.failure_reason || (b.stderr || b.stdout || 'Phase B failed').slice(0, 500);
      rows.push(row);
      fs.appendFileSync(runsPath, `${JSON.stringify(row)}\n`);
      firstFailure = firstFailure || new Error(row.error);
      continue;
    }

    Object.assign(row, {
      unauthenticated_alert_get_status: b.json.unauthenticated_alert_get_status,
      alert_challenge_status: b.json.alert_challenge_status,
      alert_token_exchange_status: b.json.alert_token_exchange_status,
      authorized_alert_get_status: b.json.authorized_alert_get_status,
      alert_challenge_latency_ms: b.json.alert_challenge_latency_ms,
      alert_token_exchange_latency_ms: b.json.alert_token_exchange_latency_ms,
      authorized_alert_get_latency_ms: b.json.authorized_alert_get_latency_ms,
      protected_alert_access_total_latency_ms: b.json.protected_alert_access_total_latency_ms,
      authorized_response_contains_current_benchmark_run_id: b.json.authorized_response_contains_expected_benchmark_run_id,
      status: 'ok',
      outcome: 'authorized',
    });

    rows.push(row);
    fs.appendFileSync(runsPath, `${JSON.stringify(row)}\n`);
  }

  const measured = rows.filter((r) => r.phase === 'measured');
  const ok = measured.filter((r) => r.status === 'ok');
  const summary = {
    benchmark_name: 'protected-alert-lifecycle-simple',
    run_id: runId,
    output_dir: outputDir,
    runs_path: runsPath,
    summary_path: summaryPath,
    request: { spo2_target: env('PANDA_SPO2_TARGET', 'http://localhost:3000/alice/spo2/'), alert_target: env('PANDA_ALERT_TARGET', 'http://localhost:3000/alice/derived/anomaly-alert/'), action: 'read', expected_outcome: 'authorized' },
    warmup_count: args.warmup,
    run_count: args.runs,
    measured_run_count: measured.length,
    authorized_runs: ok.length,
    failed_runs: measured.length - ok.length,
    metrics: {
      alert_challenge_latency_ms: { mean: mean(ok.map((r) => r.alert_challenge_latency_ms)) },
      alert_token_exchange_latency_ms: { mean: mean(ok.map((r) => r.alert_token_exchange_latency_ms)) },
      authorized_alert_get_latency_ms: { mean: mean(ok.map((r) => r.authorized_alert_get_latency_ms)) },
      protected_alert_access_total_latency_ms: { mean: mean(ok.map((r) => r.protected_alert_access_total_latency_ms)) },
    },
    accepted: measured.length === args.runs && ok.length === args.runs,
    rows,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(firstFailure ? 1 : 0);
}

main();
