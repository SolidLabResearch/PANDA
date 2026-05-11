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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireCheck(condition, message, failures) {
  if (!condition) failures.push(message);
}

function findLatestSummaryPath() {
  const root = path.join(ROOT, 'benchmark-results');
  if (!fs.existsSync(root)) {
    throw new Error(`benchmark-results directory not found: ${root}`);
  }
  const entries = fs.readdirSync(root)
    .filter((entry) => entry.startsWith('protected-alert-lifecycle-'))
    .map((entry) => {
      const dirPath = path.join(root, entry);
      const stat = fs.statSync(dirPath);
      const files = fs.readdirSync(dirPath).filter((f) => f.startsWith('protected-alert-lifecycle-') && f.endsWith('.summary.json'));
      const summaryPath = files.length ? path.join(dirPath, files[0]) : null;
      return { dirPath, stat, summaryPath };
    })
    .filter((entry) => entry.summaryPath && fs.existsSync(entry.summaryPath))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

  if (!entries.length) {
    throw new Error('No protected-alert-lifecycle benchmark results found.');
  }
  return entries[0].summaryPath;
}

function loadRunsJsonl(runsPath) {
  const text = fs.readFileSync(runsPath, 'utf8');
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function validate(summary, rows) {
  const failures = [];

  requireCheck(summary.benchmark_name === 'protected-alert-lifecycle', 'benchmark_name must be protected-alert-lifecycle', failures);
  requireCheck(typeof summary.run_id === 'string' && summary.run_id.length > 0, 'run_id must be present', failures);
  requireCheck(typeof summary.request?.spo2_target === 'string' && summary.request.spo2_target.length > 0, 'spo2_target must be present', failures);
  requireCheck(typeof summary.request?.alert_target === 'string' && summary.request.alert_target.length > 0, 'alert_target must be present', failures);
  requireCheck(summary.request?.action === 'read', 'action must be read', failures);
  requireCheck(summary.request?.expected_outcome === 'authorized', 'expected_outcome must be authorized', failures);
  requireCheck(summary.run_count >= 1, 'run_count must be >= 1', failures);
  requireCheck(summary.measured_run_count >= summary.run_count, 'measured run count is lower than configured run count', failures);
  requireCheck(summary.alert_generated_runs >= summary.run_count, 'alert_generated_runs is lower than configured run count', failures);

  const metrics = summary.metrics || {};
  const requiredSummaryMetrics = [
    'input_total_first_access_ms',
    'alert_uma_initial_challenge_ms',
    'alert_uma_token_exchange_ms',
    'alert_authorized_get_ms',
    'alert_total_first_access_ms',
    'total_lifecycle_ms',
  ];
  for (const metricName of requiredSummaryMetrics) {
    requireCheck(
      isFiniteNumber(metrics[metricName]?.mean),
      `${metricName} metric summary mean is missing or non-numeric`,
      failures,
    );
  }

  const measuredRows = rows.filter((row) => row.phase === 'measured');
  requireCheck(measuredRows.length >= summary.run_count, 'Measured rows in JSONL are fewer than configured run_count', failures);

  for (const row of measuredRows) {
    requireCheck(row.status === 'ok', `Measured row ${row.iteration} status must be ok`, failures);
    requireCheck(row.outcome === 'authorized', `Measured row ${row.iteration} outcome must be authorized`, failures);
    requireCheck(row.alert_created === true, `Measured row ${row.iteration} alert_created must be true`, failures);
    requireCheck(row.alert_resource_exists === true, `Measured row ${row.iteration} alert_resource_exists must be true`, failures);
    requireCheck(typeof row.unauthenticated_alert_get_was_public === 'boolean', `Measured row ${row.iteration} unauthenticated_alert_get_was_public must be boolean`, failures);
    requireCheck(row.unauthenticated_alert_get_was_public === false, `Measured row ${row.iteration} unauthenticated_alert_get_was_public must be false`, failures);
    requireCheck(row.alert_token_status === 200, `Measured row ${row.iteration} alert_token_status must be 200`, failures);
    requireCheck(row.alert_authorized_status === 200, `Measured row ${row.iteration} alert_authorized_status must be 200`, failures);
    requireCheck(row.final_alert_get_succeeded === true, `Measured row ${row.iteration} final_alert_get_succeeded must be true`, failures);
    requireCheck(row.lifecycle_proof_current_run_generated === true, `Measured row ${row.iteration} lifecycle_proof_current_run_generated must be true`, failures);
    requireCheck(typeof row.benchmark_run_id === 'string' && row.benchmark_run_id.length > 0, `Measured row ${row.iteration} benchmark_run_id missing`, failures);
    requireCheck(typeof row.lifecycle_raw_path === 'string' && row.lifecycle_raw_path.length > 0, `Measured row ${row.iteration} lifecycle_raw_path missing`, failures);
    requireCheck(fs.existsSync(row.lifecycle_raw_path), `Measured row ${row.iteration} lifecycle_raw_path does not exist`, failures);

    const requiredRowMetrics = [
      'input_total_first_access_ms',
      'alert_uma_initial_challenge_ms',
      'alert_uma_token_exchange_ms',
      'alert_authorized_get_ms',
      'alert_total_first_access_ms',
      'total_lifecycle_ms',
    ];
    for (const metricName of requiredRowMetrics) {
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
      ? path.join(ROOT, 'benchmark-results', `protected-alert-lifecycle-${opts.benchmarkId}`, `protected-alert-lifecycle-${opts.benchmarkId}.summary.json`)
      : findLatestSummaryPath());

  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Summary file not found: ${summaryPath}`);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const runsPath = summary.runs_path;
  if (!runsPath || !fs.existsSync(runsPath)) {
    throw new Error(`Runs JSONL file missing: ${runsPath || 'undefined'}`);
  }
  const rows = loadRunsJsonl(runsPath);
  const failures = validate(summary, rows);
  const result = {
    benchmark_name: summary.benchmark_name || 'protected-alert-lifecycle',
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
