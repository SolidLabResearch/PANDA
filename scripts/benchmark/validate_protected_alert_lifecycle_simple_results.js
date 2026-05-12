#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { summaryPath: null, benchmarkId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--summary' || arg === '--summary-path') out.summaryPath = next;
    if (arg === '--benchmark-id') out.benchmarkId = next;
  }
  return out;
}

function requireCheck(condition, message, failures) {
  if (!condition) failures.push(message);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function findLatestSummaryPath() {
  const root = path.join(ROOT, 'benchmark-results');
  if (!fs.existsSync(root)) throw new Error(`benchmark-results directory not found: ${root}`);
  const entries = fs.readdirSync(root)
    .filter((entry) => entry.startsWith('protected-alert-lifecycle-simple-'))
    .map((entry) => {
      const dirPath = path.join(root, entry);
      const stat = fs.statSync(dirPath);
      const files = fs.readdirSync(dirPath).filter((f) => f.startsWith('protected-alert-lifecycle-simple-') && f.endsWith('.summary.json'));
      const summaryPath = files.length ? path.join(dirPath, files[0]) : null;
      return { stat, summaryPath };
    })
    .filter((entry) => entry.summaryPath && fs.existsSync(entry.summaryPath))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  if (!entries.length) throw new Error('No protected-alert-lifecycle-simple benchmark results found.');
  return entries[0].summaryPath;
}

function loadRunsJsonl(runsPath) {
  const text = fs.readFileSync(runsPath, 'utf8');
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function validate(summary, rows) {
  const failures = [];

  requireCheck(summary.benchmark_name === 'protected-alert-lifecycle-simple', 'benchmark_name must be protected-alert-lifecycle-simple', failures);
  requireCheck(typeof summary.run_id === 'string' && summary.run_id.length > 0, 'run_id must be present', failures);
  requireCheck(summary.request?.alert_target === 'http://localhost:3000/alice/derived/anomaly-alert/', 'alert_target must match the derived alert URL', failures);
  requireCheck(summary.run_count >= 1, 'run_count must be >= 1', failures);

  const metrics = summary.metrics || {};
  for (const metricName of [
    'materialization_setup_ms',
    'alert_challenge_latency_ms',
    'alert_token_exchange_latency_ms',
    'authorized_alert_get_latency_ms',
    'protected_alert_access_total_latency_ms',
    'total_lifecycle_ms',
  ]) {
    requireCheck(isFiniteNumber(metrics[metricName]?.mean), `${metricName} metric is missing`, failures);
  }

  const measuredRows = rows.filter((row) => row.phase === 'measured');
  requireCheck(measuredRows.length === summary.run_count, 'Measured row count must equal configured run_count', failures);

  for (const row of measuredRows) {
    requireCheck(row.status === 'ok', `Measured row ${row.iteration} status must be ok`, failures);
    requireCheck(typeof row.benchmark_run_id === 'string' && row.benchmark_run_id.length > 0, `Measured row ${row.iteration} benchmark_run_id must be non-null`, failures);
    requireCheck(row.alert_materialized === true, `Measured row ${row.iteration} alert_materialized must be true`, failures);
    requireCheck(row.alert_contains_current_benchmark_run_id === true, `Measured row ${row.iteration} alert_contains_current_benchmark_run_id must be true`, failures);
    requireCheck(row.unauthenticated_alert_get_status !== 200, `Measured row ${row.iteration} unauthenticated_alert_get_status must not be 200`, failures);
    requireCheck(row.alert_challenge_status === 401 || row.alert_challenge_status === 403, `Measured row ${row.iteration} alert_challenge_status must be 401 or 403`, failures);
    requireCheck(row.alert_token_exchange_status === 200, `Measured row ${row.iteration} alert_token_exchange_status must be 200`, failures);
    requireCheck(row.authorized_alert_get_status === 200, `Measured row ${row.iteration} authorized_alert_get_status must be 200`, failures);
    requireCheck(row.authorized_response_contains_current_benchmark_run_id === true, `Measured row ${row.iteration} authorized response must contain current benchmark_run_id`, failures);

    for (const metricName of [
      'materialization_setup_ms',
      'alert_challenge_latency_ms',
      'alert_token_exchange_latency_ms',
      'authorized_alert_get_latency_ms',
      'protected_alert_access_total_latency_ms',
      'total_lifecycle_ms',
    ]) {
      requireCheck(
        isFiniteNumber(row[metricName]) && row[metricName] >= 0,
        `Measured row ${row.iteration} ${metricName} must be numeric and >= 0`,
        failures,
      );
    }
  }

  return failures;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const summaryPath = opts.summaryPath
    || (opts.benchmarkId
      ? path.join(ROOT, 'benchmark-results', `protected-alert-lifecycle-simple-${opts.benchmarkId}`, `protected-alert-lifecycle-simple-${opts.benchmarkId}.summary.json`)
      : findLatestSummaryPath());
  if (!fs.existsSync(summaryPath)) throw new Error(`Summary file not found: ${summaryPath}`);

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const runsPath = summary.runs_path;
  if (!runsPath || !fs.existsSync(runsPath)) throw new Error(`Runs JSONL file missing: ${runsPath || 'undefined'}`);
  const rows = loadRunsJsonl(runsPath);
  const failures = validate(summary, rows);

  const result = {
    benchmark_name: summary.benchmark_name || 'protected-alert-lifecycle-simple',
    summary_path: summaryPath,
    runs_path: runsPath,
    checked_at: new Date().toISOString(),
    passed: failures.length === 0,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}

main();
