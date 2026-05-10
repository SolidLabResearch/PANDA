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

function sanitizeMetricLabel(label) {
  return String(label || '')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function parseJsonLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
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

  const MB = 1024 * 1024;
  const resourceByLabel = {};
  const resourceWarnings = [];
  for (const row of rows) {
    const samplePathRelative = row?.resource_usage?.samples_path;
    if (!samplePathRelative) {
      resourceWarnings.push({
        scenario_id: row.scenario_id,
        run_id: row.run_id,
        warning: 'resource_samples_missing_path',
      });
      continue;
    }
    const samplePath = path.join(ROOT, samplePathRelative);
    if (!fs.existsSync(samplePath)) {
      resourceWarnings.push({
        scenario_id: row.scenario_id,
        run_id: row.run_id,
        warning: 'resource_samples_file_not_found',
        expected_path: samplePathRelative,
      });
      continue;
    }
    const lines = parseJsonLines(samplePath);
    for (const line of lines) {
      if (line.event !== 'sample' || !line.label) continue;
      const label = sanitizeMetricLabel(line.label);
      if (!resourceByLabel[label]) {
        resourceByLabel[label] = {
          rssMb: [],
          cpuPercent: [],
          heapUsedMb: [],
        };
      }
      if (isFiniteNumber(line.rss_bytes)) {
        resourceByLabel[label].rssMb.push(line.rss_bytes / MB);
      }
      if (isFiniteNumber(line.cpu_percent)) {
        resourceByLabel[label].cpuPercent.push(line.cpu_percent);
      }
      if (isFiniteNumber(line.heap_used_bytes)) {
        resourceByLabel[label].heapUsedMb.push(line.heap_used_bytes / MB);
      }
    }
  }
  const resourceMetrics = {};
  for (const [label, values] of Object.entries(resourceByLabel)) {
    const rssPeak = values.rssMb.length > 0 ? Math.max(...values.rssMb) : null;
    const rssMean = values.rssMb.length > 0 ? values.rssMb.reduce((sum, value) => sum + value, 0) / values.rssMb.length : null;
    const cpuPeak = values.cpuPercent.length > 0 ? Math.max(...values.cpuPercent) : null;
    const cpuMean = values.cpuPercent.length > 0 ? values.cpuPercent.reduce((sum, value) => sum + value, 0) / values.cpuPercent.length : null;
    resourceMetrics[`${label}_rss_peak_mb`] = rssPeak;
    resourceMetrics[`${label}_rss_mean_mb`] = rssMean;
    resourceMetrics[`${label}_cpu_mean_percent`] = cpuMean;
    resourceMetrics[`${label}_cpu_peak_percent`] = cpuPeak;
    if (values.heapUsedMb.length > 0) {
      resourceMetrics[`${label}_heap_used_peak_mb`] = Math.max(...values.heapUsedMb);
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
      resource_samples: resourceWarnings,
    },
    resource_metrics: resourceMetrics,
  };
  const outPath = path.join(runRoot, 'aggregated', 'summary.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  console.log(`aggregate_path=${outPath}`);
}

main();
