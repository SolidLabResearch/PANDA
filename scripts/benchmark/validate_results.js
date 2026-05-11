#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EPSILON_MS = 1;
const LIMITED_SCENARIO_ID = 'limited-caregiver-time-window-access';
const LIMITED_PROCESSING_SCENARIO_ID = 'limited-caregiver-time-window-processing';

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
  'limited_window_duration_ms',
  'returned_observation_count',
]);

function validate(row) {
  const m = row.metrics || {};
  const definitions = row.metric_definitions || {};
  const failures = [];

  const requireCheck = (condition, reason) => {
    if (!condition) failures.push(reason);
  };

  if (row.scenario_id === LIMITED_PROCESSING_SCENARIO_ID) {
    requireCheck(row.status !== 'running', 'run is still marked running');
    requireCheck(row.status === 'complete', 'run is not complete');
    requireCheck(row.output_check?.passed === true, 'output_check.passed is not true');
    requireCheck(row.scenario_passed === true, 'scenario_passed is not true');
    requireCheck(row.caregiver_requester_used === true, 'caregiver_requester_used is not true');
    requireCheck(row.full_stream_publicly_readable === false, 'full stream is publicly readable');
    requireCheck(row.derived_time_window_resource_publicly_readable === false, 'derived view is publicly readable');
    requireCheck(row.caregiver_can_access_full_stream === false, 'caregiver can access full stream');
    requireCheck(row.caregiver_can_access_derived_time_window === true, 'caregiver cannot access derived view');
    requireCheck(row.full_stream_content_returned_to_caregiver === false, 'full stream content was returned to caregiver');
    requireCheck(row.derived_time_window_content_returned === true, 'derived content is empty or missing');
    requireCheck(row.source_events_written_count >= 602, 'source_events_written_count must be at least 602');
    requireCheck(row.in_window_events_written_count === 600, 'in_window_events_written_count must equal 600');
    requireCheck(row.out_of_window_events_written_count >= 2, 'out_of_window_events_written_count must be at least 2');
    requireCheck(row.expected_derived_observation_count === 600, 'expected_derived_observation_count must equal 600');
    requireCheck(row.returned_observation_count === 600, 'returned_observation_count must equal 600');
    requireCheck(row.returned_observations_within_window === true, 'returned observations are not proven to be inside the configured window');
    requireCheck(Array.isArray(row.out_of_window_observations_returned) && row.out_of_window_observations_returned.length === 0, 'out-of-window observations were returned by the derived view');
    requireCheck(row.content_matches_time_window === true, 'content_matches_time_window is not true');
    requireCheck(row.rsp_event_add_count_total === 600, 'rsp_event_add_count_total must equal 600');
    requireCheck(m.derived_view_observation_count === 600, 'derived_view_observation_count must equal 600');
    requireCheck(isFiniteNumber(m.derived_view_fetch_ms) && m.derived_view_fetch_ms >= 0, 'derived_view_fetch_ms must exist');
    requireCheck(isFiniteNumber(m.derived_view_payload_size_bytes) && m.derived_view_payload_size_bytes > 0, 'derived_view_payload_size_bytes must exist and be > 0');
    requireCheck(isFiniteNumber(m.derived_view_parse_ms) && m.derived_view_parse_ms >= 0, 'derived_view_parse_ms must exist');
    requireCheck(isFiniteNumber(m.bounded_observation_ingest_total_ms) && m.bounded_observation_ingest_total_ms >= 0, 'bounded_observation_ingest_total_ms must exist');
    requireCheck(isFiniteNumber(m.bounded_observation_ingest_mean_ms) && m.bounded_observation_ingest_mean_ms >= 0, 'bounded_observation_ingest_mean_ms must exist');
    requireCheck(row.rsp_result_count >= 1, 'rsp_result_count must be at least 1');
    requireCheck(row.monitoring_result_produced === true, 'monitoring_result_produced is not true');
    if (row.expected_anomaly === true) {
      requireCheck(row.anomaly_result_generated === true, 'anomaly_result_generated is not true even though the scenario expects an anomaly');
    }
    requireCheck(isFiniteNumber(m.query_registered_to_result_received_ms) && m.query_registered_to_result_received_ms > 0, 'query_registered_to_result_received_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.derived_time_window_fetch_ms) && m.derived_time_window_fetch_ms >= 0, 'derived_time_window_fetch_ms must exist');
    requireCheck(isFiniteNumber(m.preload_observations_ms) && m.preload_observations_ms >= 0, 'preload_observations_ms must exist');
    requireCheck(isFiniteNumber(m.rsp_event_add_total_ms) && m.rsp_event_add_total_ms >= 0, 'rsp_event_add_total_ms must exist');
    requireCheck(isFiniteNumber(m.rsp_first_result_emit_ms) && m.rsp_first_result_emit_ms >= 0, 'rsp_first_result_emit_ms must exist');
    requireCheck(typeof row.returned_observation_min_timestamp === 'string' && row.returned_observation_min_timestamp.length > 0, 'returned_observation_min_timestamp is missing');
    requireCheck(typeof row.returned_observation_max_timestamp === 'string' && row.returned_observation_max_timestamp.length > 0, 'returned_observation_max_timestamp is missing');
    requireCheck(typeof row.limited_window_start === 'string' && row.limited_window_start.length > 0, 'limited_window_start is missing');
    requireCheck(typeof row.limited_window_end === 'string' && row.limited_window_end.length > 0, 'limited_window_end is missing');
    const windowStartMs = Date.parse(row.limited_window_start || '');
    const windowEndMs = Date.parse(row.limited_window_end || '');
    const minMs = Date.parse(row.returned_observation_min_timestamp || '');
    const maxMs = Date.parse(row.returned_observation_max_timestamp || '');
    requireCheck(Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs), 'configured time window is not parseable');
    requireCheck(Number.isFinite(minMs) && Number.isFinite(maxMs), 'timestamp validation is missing or inconclusive');
    if (Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs) && Number.isFinite(minMs) && Number.isFinite(maxMs)) {
      requireCheck(minMs >= windowStartMs, 'minimum returned observation timestamp is before the configured window');
      requireCheck(maxMs < windowEndMs, 'maximum returned observation timestamp is outside the configured half-open window');
      requireCheck(maxMs - minMs >= 599000, 'returned observation timestamps do not cover the expected 10-minute interval');
    }
    requireCheck(row.accepted_result_validation_reason === 'event_time_span_full_window' || row.accepted_result_validation_reason === 'rsp_engine_window_metadata_full_window', 'accepted result does not prove a full 10-minute window');
    requireCheck(isFiniteNumber(row.accepted_result_event_time_span_ms) || isFiniteNumber(row.accepted_result_rsp_window_metadata_span_ms), 'accepted result window evidence is missing');
    if (row.accepted_result_validation_reason === 'event_time_span_full_window') {
      requireCheck(isFiniteNumber(row.accepted_result_event_time_span_ms) && row.accepted_result_event_time_span_ms >= 600000, 'accepted result event-time span is shorter than 10 minutes');
    }
    if (row.accepted_result_validation_reason === 'rsp_engine_window_metadata_full_window') {
      requireCheck(isFiniteNumber(row.accepted_result_rsp_window_metadata_span_ms) && row.accepted_result_rsp_window_metadata_span_ms >= 600000, 'accepted result RSP window metadata span is shorter than 10 minutes');
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

  if (row.scenario_id === LIMITED_SCENARIO_ID) {
    requireCheck(row.status !== 'running', 'run is still marked running');
    requireCheck(row.status === 'complete', 'run is not complete');
    requireCheck(row.output_check?.passed === true, 'output_check.passed is not true');
    requireCheck(row.scenario_passed === true, 'scenario_passed is not true');
    requireCheck(row.full_stream_publicly_readable === false, 'full stream is publicly readable');
    requireCheck(row.derived_time_window_resource_publicly_readable === false, 'derived view is publicly readable');
    requireCheck(row.caregiver_requester_used === true, 'caregiver_requester_used is not true');
    requireCheck(row.caregiver_can_access_full_stream === false, 'caregiver can access full stream');
    requireCheck(row.caregiver_can_access_derived_time_window === true, 'caregiver cannot access derived view');
    requireCheck(row.derived_time_window_content_returned === true, 'derived content is empty or missing');
    requireCheck(row.full_stream_content_returned_to_caregiver === false, 'full stream content was returned to caregiver');
    requireCheck(isFiniteNumber(row.returned_observation_count) && row.returned_observation_count > 0, 'returned_observation_count must exist and be > 0');
    requireCheck(row.returned_observations_within_window === true, 'returned observations are not proven to be inside the configured window');
    requireCheck(row.content_matches_time_window === true, 'content_matches_time_window is not true');
    requireCheck(typeof row.returned_observation_min_timestamp === 'string' && row.returned_observation_min_timestamp.length > 0, 'returned_observation_min_timestamp is missing');
    requireCheck(typeof row.returned_observation_max_timestamp === 'string' && row.returned_observation_max_timestamp.length > 0, 'returned_observation_max_timestamp is missing');
    requireCheck(typeof row.limited_window_start === 'string' && row.limited_window_start.length > 0, 'limited_window_start is missing');
    requireCheck(typeof row.limited_window_end === 'string' && row.limited_window_end.length > 0, 'limited_window_end is missing');
    const windowStartMs = Date.parse(row.limited_window_start || '');
    const windowEndMs = Date.parse(row.limited_window_end || '');
    const minMs = Date.parse(row.returned_observation_min_timestamp || '');
    const maxMs = Date.parse(row.returned_observation_max_timestamp || '');
    requireCheck(Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs), 'configured time window is not parseable');
    requireCheck(Number.isFinite(minMs) && Number.isFinite(maxMs), 'timestamp validation is missing or inconclusive');
    if (Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs) && Number.isFinite(minMs) && Number.isFinite(maxMs)) {
      requireCheck(minMs >= windowStartMs, 'minimum returned observation timestamp is before the configured window');
      requireCheck(maxMs < windowEndMs, 'maximum returned observation timestamp is outside the configured half-open window');
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
