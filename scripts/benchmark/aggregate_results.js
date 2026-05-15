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

function buildSummary(rows, benchmarkId) {
  const completeRows = rows.filter((row) => (
    (row.phase === 'measured' || (typeof row.run_id === 'number' && row.run_id > 0))
    && row.status === 'complete' && row.output_check?.passed === true
  ));

  const metricNames = new Set();
  const unavailableMetrics = new Set();
  const missingDefinitions = new Set();
  const firstAnyResultClassifications = new Set();
  for (const row of completeRows) {
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
  [
    'rsp_callback_to_parse_done_ms',
    'rsp_result_parse_ms',
    'rule_evaluation_only_ms',
    'benchmark_result_construction_ms',
    'post_rule_source_event_lookup_ms',
    'post_rule_numeric_value_extraction_ms',
    'post_rule_validation_or_classification_ms',
    'post_rule_raw_result_logging_ms',
    'post_rule_alert_materialization_ms',
    'post_rule_protected_metadata_prepare_ms',
    'post_rule_query_hash_ms',
    'post_rule_protected_result_materialization_ms',
    'post_rule_payload_prepare_ms',
    'post_rule_timing_finalize_ms',
    'post_rule_serialization_or_clone_ms',
    'post_rule_benchmark_result_logging_ms',
    'post_rule_to_websocket_send_ms',
    'post_rule_logging_ms',
    'post_rule_unaccounted_ms',
    'websocket_send_ms',
    'rsp_callback_total_processing_ms',
  ].forEach((metric) => metricNames.add(metric));

  const metrics = {};
  const criticalPathMetricOrder = [
    'replayer_start_to_query_register_ms',
    'query_registered_to_result_received_ms',
    'end_to_end_replayer_to_rsp_output_ms',
    'rsp_callback_to_parse_done_ms',
    'rsp_result_parse_ms',
    'rule_evaluation_only_ms',
    'benchmark_result_construction_ms',
    'post_rule_source_event_lookup_ms',
    'post_rule_numeric_value_extraction_ms',
    'post_rule_validation_or_classification_ms',
    'post_rule_raw_result_logging_ms',
    'post_rule_alert_materialization_ms',
    'post_rule_protected_metadata_prepare_ms',
    'post_rule_query_hash_ms',
    'post_rule_protected_result_materialization_ms',
    'post_rule_payload_prepare_ms',
    'post_rule_timing_finalize_ms',
    'post_rule_serialization_or_clone_ms',
    'post_rule_benchmark_result_logging_ms',
    'post_rule_to_websocket_send_ms',
    'post_rule_logging_ms',
    'post_rule_unaccounted_ms',
    'websocket_send_ms',
    'rsp_callback_total_processing_ms',
    'rsp_emit_to_protected_write_start_ms',
    'protected_write_start_to_complete_ms',
    'protected_write_complete_to_notification_ms',
    'notification_to_nurse_read_complete_ms',
    'rsp_emit_to_nurse_read_complete_ms',
    'query_register_to_nurse_read_complete_ms',
    'replayer_start_to_nurse_read_complete_ms',
    'rsp_output_to_panda_result_write_ms',
    'panda_result_write_total_ms',
    'panda_result_write_to_notification_ms',
    'created_at_to_notification_ms',
    'nurse_notification_to_uma_get_start_ms',
    'nurse_result_uma_challenge_ms',
    'nurse_result_token_exchange_ms',
    'nurse_result_authorized_get_ms',
    'nurse_result_total_read_ms',
    'query_registration_to_nurse_result_read_ms',
    'end_to_end_replayer_to_nurse_result_read_ms',
  ];
  const lowerNMetrics = [];
  for (const metric of Array.from(metricNames).sort()) {
    const values = completeRows
      .map((row) => row.metrics?.[metric] ?? row[metric])
      .filter((value) => isFiniteNumber(value));
    metrics[metric] = summarize(values);
    if (values.length < completeRows.length) {
      lowerNMetrics.push({
        metric,
        n: values.length,
        complete_valid_runs: completeRows.length,
      });
    }
  }

  const MB = 1024 * 1024;
  const resourceByLabel = {};
  const resourceWarnings = [];
  for (const row of completeRows) {
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
    benchmark_id: benchmarkId,
    generated_at: new Date().toISOString(),
    complete_valid_runs: completeRows.length,
    metrics,
    warnings: {
      unavailable_metrics: Array.from(unavailableMetrics).sort(),
      metrics_with_n_lower_than_complete_valid_runs: lowerNMetrics,
      metrics_missing_definitions: Array.from(missingDefinitions).sort(),
      first_any_result_classifications: Array.from(firstAnyResultClassifications).sort(),
      resource_samples: resourceWarnings,
    },
    critical_path_metrics_in_order: criticalPathMetricOrder
      .filter((metric) => metrics[metric])
      .map((metric) => ({ metric, summary: metrics[metric] })),
    resource_metrics: resourceMetrics,
  };
  return output;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runRoot = path.join(ROOT, 'benchmarks', 'results', 'runs', opts.benchmarkId);
  const rawDir = path.join(runRoot, 'raw');
  const rows = fs.readdirSync(rawDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')));
  const output = buildSummary(rows, opts.benchmarkId);
  const outPath = path.join(runRoot, 'aggregated', 'summary.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  console.log(`aggregate_path=${outPath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildSummary,
  isFiniteNumber,
  percentile,
  summarize,
};
