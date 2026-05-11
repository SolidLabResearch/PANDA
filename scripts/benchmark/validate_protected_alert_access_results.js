#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { benchmarkId: null, summaryPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--benchmark-id') out.benchmarkId = argv[index + 1];
    if (argv[index] === '--summary-path' || argv[index] === '--summary') out.summaryPath = argv[index + 1];
  }
  return out;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function findLatestSummaryPath() {
  const benchmarkRoot = path.join(ROOT, 'benchmark-results');
  if (!fs.existsSync(benchmarkRoot)) {
    throw new Error(`benchmark-results directory not found: ${benchmarkRoot}`);
  }
  const entries = fs.readdirSync(benchmarkRoot)
    .filter((entry) => entry.startsWith('protected-alert-access-'))
    .map((entry) => {
      const dirPath = path.join(benchmarkRoot, entry);
      const stat = fs.statSync(dirPath);
      let found = null;
      try {
        const files = fs.readdirSync(dirPath);
        for (const f of files) {
          if (f.startsWith('protected-alert-access-') && f.endsWith('.summary.json')) {
            found = path.join(dirPath, f);
            break;
          }
        }
      } catch (e) {
        // ignore
      }
      return { entry, summaryPath: found, stat };
    })
    .filter(({ summaryPath }) => summaryPath && fs.existsSync(summaryPath))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

  if (!entries.length) {
    throw new Error('No protected-alert-access benchmark results found.');
  }

  return entries[0].summaryPath;
}

function requireCheck(condition, reason, failures) {
  if (!condition) failures.push(reason);
}

function validate(summary) {
  const failures = [];
  const metrics = summary.metrics || {};
  const rows = Array.isArray(summary.rows) ? summary.rows : [];

  requireCheck(summary.benchmark_name === 'protected-alert-access', 'benchmark_name must be protected-alert-access', failures);
  requireCheck(typeof summary.run_id === 'string' && summary.run_id.length > 0, 'run_id must be present', failures);
  requireCheck(typeof summary.request?.alert_target === 'string' && summary.request.alert_target.length > 0, 'alert_target must be present', failures);
  requireCheck(summary.request?.alert_target === 'http://localhost:3000/alice/derived/anomaly-alert/', 'alert_target must match the derived alert container URL', failures);
  requireCheck(summary.request?.action === 'read', 'action must be read', failures);
  requireCheck(summary.request?.expected_outcome === 'authorized', 'expected_outcome must be authorized', failures);
  requireCheck(typeof summary.request?.requester_webid === 'string' && summary.request.requester_webid.length > 0, 'requester_webid must be present', failures);
  requireCheck(summary.run_count >= 1, 'run_count must be >= 1', failures);
  requireCheck(summary.measured_run_count >= summary.run_count, 'measured run count is lower than configured run count', failures);
  requireCheck(summary.authorized_runs === summary.run_count, 'authorized_runs must equal the configured run_count', failures);
  requireCheck(summary.failed_runs === 0, 'failed_runs must be 0', failures);
  requireCheck(summary.status === 'ok', 'status must be ok', failures);
  requireCheck(summary.outcome === 'authorized', 'outcome must be authorized', failures);

  requireCheck(isFiniteNumber(metrics.alert_uma_initial_challenge_ms?.mean), 'alert_uma_initial_challenge_ms metric is missing', failures);
  requireCheck(isFiniteNumber(metrics.alert_uma_token_exchange_ms?.mean), 'alert_uma_token_exchange_ms metric is missing', failures);
  requireCheck(isFiniteNumber(metrics.alert_authorized_get_ms?.mean), 'alert_authorized_get_ms metric is missing', failures);
  requireCheck(isFiniteNumber(metrics.alert_total_first_access_ms?.mean), 'alert_total_first_access_ms metric is missing', failures);

  for (const row of rows) {
    if (row.phase !== 'measured') continue;
    requireCheck(typeof row.alert_target === 'string' && row.alert_target.length > 0, 'row.alert_target must be present', failures);
    requireCheck(row.challenge_status !== 200, 'unauthenticated alert GET returned 200', failures);
    requireCheck(row.challenge_status === 401 || row.challenge_status === 403, 'unauthenticated alert GET must return 401 or 403', failures);
    requireCheck(isFiniteNumber(row.alert_uma_initial_challenge_ms) && row.alert_uma_initial_challenge_ms >= 0, 'alert_uma_initial_challenge_ms must be present', failures);
    requireCheck(isFiniteNumber(row.alert_uma_token_exchange_ms) && row.alert_uma_token_exchange_ms >= 0, 'alert_uma_token_exchange_ms must be present', failures);
    requireCheck(isFiniteNumber(row.alert_authorized_get_ms) && row.alert_authorized_get_ms >= 0, 'alert_authorized_get_ms must be present', failures);
    requireCheck(isFiniteNumber(row.alert_total_first_access_ms) && row.alert_total_first_access_ms >= 0, 'alert_total_first_access_ms must be present', failures);
    requireCheck(row.token_status === 200, 'token_status must be 200', failures);
    requireCheck(row.authorized_status === 200, 'authorized_status must be 200', failures);
    requireCheck(row.final_alert_get_succeeded === true, 'final_alert_get_succeeded must be true', failures);
    requireCheck(row.status === 'ok', 'row.status must be ok', failures);
    requireCheck(row.outcome === 'authorized', 'row.outcome must be authorized', failures);
  }

  return failures;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const summaryPath = opts.summaryPath || (opts.benchmarkId
    ? path.join(ROOT, 'benchmark-results', `protected-alert-access-${opts.benchmarkId}`, 'summary.json')
    : findLatestSummaryPath());

  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Summary file not found: ${summaryPath}`);
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const failures = validate(summary);
  const output = {
    benchmark_name: summary.benchmark_name || 'protected-alert-access',
    summary_path: summaryPath,
    checked_at: new Date().toISOString(),
    passed: failures.length === 0,
    failures,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(output.passed ? 0 : 1);
}

main();