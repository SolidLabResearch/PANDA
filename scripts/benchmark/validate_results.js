#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EPSILON_MS = 1;

function parseArgs(argv) {
  const out = { benchmarkId: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--benchmark-id') out.benchmarkId = argv[i + 1];
  }
  if (!out.benchmarkId) throw new Error('--benchmark-id is required');
  return out;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function timelineEvent(row, eventName) {
  return (row.critical_path_timeline || []).find((event) => event.event === eventName);
}

function nearlyEqual(left, right, epsilon = EPSILON_MS) {
  return Math.abs(left - right) <= epsilon;
}

const NUMERIC_METADATA_FIELDS = new Set([
  'run_id',
  'query_window_seconds',
  'query_registration_delay_seconds',
  'replayer_duration_seconds',
]);
const JIM_WEBID = 'http://localhost:3000/jim/profile/card#me';

function validateDenial(row) {
  const failures = [];
  const requireCheck = (condition, reason) => {
    if (!condition) failures.push(reason);
  };
  requireCheck(row.status !== 'running', 'run is still marked running');
  requireCheck(row.status === 'complete', 'run is not complete');
  requireCheck(row.output_check?.passed === true, 'output_check.passed is not true');
  requireCheck(row.scenario_passed === true, 'scenario_passed is not true');
  requireCheck(row.unauthorized_requester_used === true, 'unauthorized_requester_used is not true');
  requireCheck(row.unauthorized_actor_webid === JIM_WEBID, 'unauthorized_actor_webid is not Jim');
  requireCheck(row.unauthorized_actor_present_in_policy === false, 'unauthorized_actor_present_in_policy is not false');
  requireCheck(row.resource_publicly_readable === false, 'resource_publicly_readable is not false');
  requireCheck(row.protected_content_returned === false, 'protected_content_returned is not false');
  requireCheck(row.denial_observed === true, 'denial_observed is not true');
  requireCheck(row.monitoring_started_from_unauthorized_data === false, 'monitoring_started_from_unauthorized_data is not false');
  if (row.effective_actor_webid_observable === true) {
    requireCheck(row.effective_actor_webid === JIM_WEBID, 'effective_actor_webid is observable and is not Jim');
  }
  const definitions = row.metric_definitions || {};
  for (const [key, value] of Object.entries(row.metrics || {})) {
    if (value !== null && value !== undefined) {
      requireCheck(Boolean(definitions[key]), `missing metric_definitions entry for ${key}`);
    }
  }
  return failures;
}

function validate(row) {
  if (row.expected_decision === 'deny' || row.scenario_id === 'policy-based-denial') {
    return validateDenial(row);
  }
  const m = row.metrics || {};
  const definitions = row.metric_definitions || {};
  const failures = [];

  const requireCheck = (condition, reason) => {
    if (!condition) failures.push(reason);
  };

  requireCheck(row.status !== 'running', 'run is still marked running');
  requireCheck(row.status === 'complete', 'run is not complete');
  requireCheck(row.output_check?.passed === true, 'output_check.passed is not true');
  requireCheck(isFiniteNumber(m.query_registered_to_result_received_ms) && m.query_registered_to_result_received_ms > 0, 'query_registered_to_result_received_ms must exist and be > 0');
  requireCheck(isFiniteNumber(m.expected_window_wait_ms), 'expected_window_wait_ms must exist');
  if (isFiniteNumber(m.expected_window_wait_ms)) {
    requireCheck(m.expected_window_wait_ms === row.query_window_seconds * 1000, 'expected_window_wait_ms must equal query_window_seconds * 1000');
  }
  requireCheck(isFiniteNumber(m.rsp_first_any_result_emit_ms) && m.rsp_first_any_result_emit_ms > 0, 'rsp_first_any_result_emit_ms must exist and be > 0');
  requireCheck(isFiniteNumber(m.window_adjusted_observed_latency_ms), 'window_adjusted_observed_latency_ms must exist');
  if (isFiniteNumber(m.query_registered_to_result_received_ms) && isFiniteNumber(m.expected_window_wait_ms) && isFiniteNumber(m.window_adjusted_observed_latency_ms)) {
    requireCheck(
      nearlyEqual(m.window_adjusted_observed_latency_ms, m.query_registered_to_result_received_ms - m.expected_window_wait_ms),
      'window_adjusted_observed_latency_ms is not derived from query_registered_to_result_received_ms - expected_window_wait_ms',
    );
  }
  requireCheck(isFiniteNumber(m.rsp_first_post_registration_event_added_to_result_received_ms) && m.rsp_first_post_registration_event_added_to_result_received_ms > 0, 'rsp_first_post_registration_event_added_to_result_received_ms must exist and be > 0');
  requireCheck(m.result_count > 0, 'result_count must be > 0');
  requireCheck(row.accepted_result_validation_reason !== 'event_count_full_window', 'accepted result must not be validated by event count alone');
  requireCheck(row.accepted_result_validation_reason !== 'wall_clock_full_window', 'accepted result must not be validated by wall-clock elapsed time alone');
  const fullWindowMs = row.query_window_seconds * 1000;
  const acceptedByEventSpan = row.accepted_result_validation_reason === 'event_time_span_full_window'
    && isFiniteNumber(row.accepted_result_event_time_span_ms)
    && row.accepted_result_event_time_span_ms >= fullWindowMs;
  const acceptedByRspWindowMetadata = row.accepted_result_validation_reason === 'rsp_engine_window_metadata_full_window'
    && row.accepted_result_rsp_window_metadata_source === 'rsp_engine_epoch_ms'
    && isFiniteNumber(row.accepted_result_rsp_window_metadata_span_ms)
    && row.accepted_result_rsp_window_metadata_span_ms >= fullWindowMs;
  requireCheck(
    acceptedByEventSpan || acceptedByRspWindowMetadata,
    'accepted result must prove a full query window by event timestamp span or explicit RSP window metadata',
  );
  if (row.accepted_result_event_time_span_ms === null || row.accepted_result_event_time_span_ms === undefined) {
    requireCheck(
      acceptedByRspWindowMetadata,
      'accepted_result_event_time_span_ms is missing and no explicit RSP window metadata proves a full window',
    );
  }
  if (isFiniteNumber(row.accepted_result_event_count) && !acceptedByEventSpan && !acceptedByRspWindowMetadata) {
    requireCheck(false, 'accepted_result_event_count exists but does not prove a full window');
  }

  const queryStart = timelineEvent(row, 'query_register_start');
  const firstAdded = timelineEvent(row, 'rsp_first_event_after_query_register_added');
  const firstAnyResult = timelineEvent(row, 'rsp_first_any_result_emit_ms');
  const clientResult = timelineEvent(row, 'client_first_valid_result_received');
  requireCheck(Boolean(queryStart), 'critical_path_timeline must include query_register_start');
  requireCheck(Boolean(firstAdded), 'critical_path_timeline must include rsp_first_event_after_query_register_added');
  requireCheck(Boolean(firstAnyResult), 'critical_path_timeline must include rsp_first_any_result_emit_ms');
  requireCheck(Boolean(clientResult), 'critical_path_timeline must include client_first_valid_result_received');
  if (queryStart && clientResult) {
    requireCheck(clientResult.t_relative_ms >= queryStart.t_relative_ms, 'client_first_valid_result_received must appear after query_register_start');
  }
  if (queryStart && firstAdded) {
    requireCheck(firstAdded.t_relative_ms >= queryStart.t_relative_ms, 'rsp_first_event_after_query_register_added must appear after query_register_start');
  }
  if (queryStart && firstAnyResult) {
    requireCheck(firstAnyResult.t_relative_ms >= queryStart.t_relative_ms, 'rsp_first_any_result_emit_ms must appear after query_register_start');
  }
  if (firstAdded && clientResult) {
    requireCheck(clientResult.t_relative_ms >= firstAdded.t_relative_ms, 'client_first_valid_result_received must appear after rsp_first_event_after_query_register_added');
  }

  if ((isFiniteNumber(row.rsp_first_any_result_event_count) || isFiniteNumber(row.rsp_first_any_result_event_time_span_ms))
    && typeof row.rsp_first_any_result_classification !== 'string') {
    requireCheck(false, 'rsp_first_any_result_classification must exist when first-any-result count or span is present');
  }

  for (const metric of Object.keys(m)) {
    requireCheck(Boolean(definitions[metric]), `missing metric_definitions entry for ${metric}`);
  }
  for (const [key, value] of Object.entries(row)) {
    if (!isFiniteNumber(value) || NUMERIC_METADATA_FIELDS.has(key)) continue;
    requireCheck(Boolean(definitions[key]), `missing metric_definitions entry for ${key}`);
  }
  for (const [metric, definition] of Object.entries(definitions)) {
    if (definition.type === 'unavailable') {
      requireCheck(m[metric] === null || m[metric] === undefined, `${metric} is unavailable but raw metric value is ${m[metric]}`);
    }
  }

  return failures;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runRoot = path.join(ROOT, 'benchmarks', 'results', 'runs', opts.benchmarkId);
  const rawDir = path.join(runRoot, 'raw');
  const allFiles = fs.readdirSync(rawDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, row: JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')) }));
  // Ignore warmup artifacts and legacy negative run ids when validating measured-run completeness.
  const measured = allFiles.filter(({ file, row }) => (
    row.phase === 'measured' || (typeof row.run_id === 'number' && row.run_id > 0)
  ));
  const failures = measured
    .map(({ file, row }) => ({ file, row, reasons: validate(row) }))
    .filter(({ reasons }) => reasons.length > 0);
  const output = {
    benchmark_id: opts.benchmarkId,
    checked_at: new Date().toISOString(),
    total_raw_files: measured.length,
    passed: failures.length === 0 && measured.length > 0,
    failures: failures.map(({ file, row, reasons }) => ({
      file,
      scenario_id: row.scenario_id,
      run_id: row.run_id,
      status: row.status,
      output_check: row.output_check,
      reasons,
    })),
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.passed ? 0 : 1);
}

main();
