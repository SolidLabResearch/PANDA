#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { benchmarkId: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--benchmark-id') out.benchmarkId = argv[i + 1];
  }
  if (!out.benchmarkId) {
    throw new Error('--benchmark-id is required');
  }
  return out;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function summarize(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function aggregateDebugFieldNames(row) {
  return Object.keys(row).filter((key) => (
    key.startsWith('accepted_result_') || key.startsWith('last_ignored_') || key.startsWith('rsp_first_any_result_')
  ) && isFiniteNumber(row[key]));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runRoot = path.join(ROOT, 'benchmarks', 'results', 'runs', opts.benchmarkId);
  const rawDir = path.join(runRoot, 'raw');
  const allFiles = fs.readdirSync(rawDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')));
  // Exclude warmup artifacts and legacy negative run ids from aggregation.
  const rows = allFiles.filter((row) => (
    (row.phase === 'measured' || (typeof row.run_id === 'number' && row.run_id > 0))
    && row.status === 'complete' && row.output_check?.passed === true
  ));

  const metricNames = new Set();
  const unavailableMetrics = new Set();
  const missingDefinitions = new Set();
  const firstAnyResultClassifications = new Set();
  for (const row of rows) {
    const definitions = row.metric_definitions || {};
    if (typeof row.rsp_first_any_result_classification === 'string' && row.rsp_first_any_result_classification.length > 0) {
      firstAnyResultClassifications.add(row.rsp_first_any_result_classification);
    }
    for (const [key, value] of Object.entries(row.metrics || {})) {
      const definition = definitions[key];
      if (!definition) {
        missingDefinitions.add(key);
      }
      if (definition?.type === 'unavailable') {
        unavailableMetrics.add(key);
        continue;
      }
      if (value !== null && value !== undefined) {
        metricNames.add(key);
      }
    }
    for (const [key, definition] of Object.entries(definitions)) {
      if (definition.type === 'unavailable') {
        unavailableMetrics.add(key);
      }
    }
    for (const key of aggregateDebugFieldNames(row)) {
      metricNames.add(key);
    }
  }

  const metrics = {};
  const lowerNMetrics = [];
  for (const metric of Array.from(metricNames).sort()) {
    const values = rows
      .map((row) => row.metrics?.[metric] ?? row[metric])
      .filter((value) => isFiniteNumber(value));
    metrics[metric] = summarize(values);
    if (values.length < rows.length) {
      lowerNMetrics.push({
        metric,
        n: values.length,
        complete_valid_runs: rows.length,
      });
    }
  }

  const output = {
    benchmark_id: opts.benchmarkId,
    generated_at: new Date().toISOString(),
    complete_valid_runs: rows.length,
    metrics,
    warnings: {
      unavailable_metrics: Array.from(unavailableMetrics).sort(),
      metrics_with_n_lower_than_complete_valid_runs: lowerNMetrics,
      metrics_missing_definitions: Array.from(missingDefinitions).sort(),
      first_any_result_classifications: Array.from(firstAnyResultClassifications).sort(),
    },
  };
  const outPath = path.join(runRoot, 'aggregated', 'summary.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  console.log(`aggregate_path=${outPath}`);
}

main();
