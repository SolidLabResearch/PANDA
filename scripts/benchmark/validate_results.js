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

function validate(row) {
  const m = row.metrics || {};
  const definitions = row.metric_definitions || {};
  const failures = [];

  const requireCheck = (condition, reason) => {
    if (!condition) failures.push(reason);
  };

  if (row.scenario_id === 'uma-replayer-panda-derived-anomaly-e2e') {
    requireCheck(row.status === 'complete', 'run is not complete');
    requireCheck(row.output_check?.passed === true, 'output_check.passed is not true');
    requireCheck(row.actor_proof?.replayer_wrote_spo2_observations === true, 'Replayer did not write SpO2 observations');
    requireCheck(row.actor_proof?.replayer_write_through_uma === true, 'Replayer SpO2 write did not prove UMA');
    requireCheck(row.actor_proof?.panda_registered_query === true, 'PANDA query registration proof is missing');
    requireCheck(row.actor_proof?.current_run_rsp_output_observed === true, 'Current-run RSP output proof is missing');
    requireCheck(row.actor_proof?.panda_wrote_anomaly_alerts === true, 'PANDA did not write anomaly alerts');
    requireCheck(row.actor_proof?.alice_read_latest_anomaly === true, 'Alice did not read latest-anomaly');
    requireCheck(isFiniteNumber(m.ws_connect_ms) && m.ws_connect_ms >= 0, 'ws_connect_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.query_registration_send_to_ack_ms) && m.query_registration_send_to_ack_ms >= 0, 'query_registration_send_to_ack_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.query_registration_to_first_rsp_output_ms) && m.query_registration_to_first_rsp_output_ms > 0, 'query_registration_to_first_rsp_output_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.replayer_first_observation_write_ms) && m.replayer_first_observation_write_ms > 0, 'replayer_first_observation_write_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.rsp_result_to_panda_anomaly_pod_write_ms) && m.rsp_result_to_panda_anomaly_pod_write_ms >= 0, 'rsp_result_to_panda_anomaly_pod_write_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.panda_anomaly_pod_write_total_ms) && m.panda_anomaly_pod_write_total_ms >= 0, 'panda_anomaly_pod_write_total_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.alice_latest_anomaly_total_read_ms) && m.alice_latest_anomaly_total_read_ms > 0, 'alice_latest_anomaly_total_read_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.end_to_end_replayer_to_rsp_output_ms) && m.end_to_end_replayer_to_rsp_output_ms > 0, 'end_to_end_replayer_to_rsp_output_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.end_to_end_replayer_to_alice_latest_anomaly_ms) && m.end_to_end_replayer_to_alice_latest_anomaly_ms > 0, 'end_to_end_replayer_to_alice_latest_anomaly_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.rsp_output_to_panda_alert_write_success_ms) && m.rsp_output_to_panda_alert_write_success_ms >= 0, 'rsp_output_to_panda_alert_write_success_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.panda_alert_write_success_to_alice_latest_read_success_ms) && m.panda_alert_write_success_to_alice_latest_read_success_ms >= 0, 'panda_alert_write_success_to_alice_latest_read_success_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.alice_latest_read_poll_duration_ms) && m.alice_latest_read_poll_duration_ms >= 0, 'alice_latest_read_poll_duration_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.rsp_output_to_alice_latest_anomaly_success_ms) && m.rsp_output_to_alice_latest_anomaly_success_ms > 0, 'rsp_output_to_alice_latest_anomaly_success_ms must exist and be > 0');
    requireCheck((row.protected_resource_proof || []).length >= 4, 'protected resource proof must include all required targets');
    requireCheck(!(row.protected_resource_proof || []).some((entry) => entry.status === 200), 'protected resource proof contains public HTTP 200');
    requireCheck(typeof row.latest_anomaly_sample === 'string' && row.latest_anomaly_sample.includes(row.benchmark_run_id), 'latest-anomaly sample does not contain benchmark run id');
    requireCheck(!/smoke-derived-anomaly-alert/i.test(row.latest_anomaly_sample || ''), 'latest-anomaly sample appears to be stale content from smoke-derived-anomaly-alert');
    requireCheck(/derivedFrom[^\n]*"rsp-query-result"/i.test(row.latest_anomaly_sample || ''), 'latest-anomaly sample does not contain the RSP-derived marker');
    requireCheck(/rspQueryHash/i.test(row.latest_anomaly_sample || ''), 'latest-anomaly sample does not contain rspQueryHash proof');
    requireCheck(/rspWindowStart/i.test(row.latest_anomaly_sample || '') && /rspWindowEnd/i.test(row.latest_anomaly_sample || ''), 'latest-anomaly sample does not contain RSP window proof');
    const rspQueryHashFromSample = (row.latest_anomaly_sample || '').match(/rspQueryHash["\s:]*([a-f0-9]+)/i)?.[1] || null;
    if (typeof row.rsp_output_proof?.query_hash === 'string' && rspQueryHashFromSample) {
      requireCheck(rspQueryHashFromSample === row.rsp_output_proof.query_hash, `latest-anomaly sample rspQueryHash (${rspQueryHashFromSample}) does not match the accepted RSP output query hash (${row.rsp_output_proof.query_hash})`);
    }
    requireCheck(row.latest_anomaly_diagnostics?.status_code === 200, 'Alice latest-anomaly HTTP status is not 200');
    requireCheck(row.latest_anomaly_diagnostics?.rsp_proof_verified === true, 'Alice latest-anomaly RSP proof verification is missing');
    requireCheck(row.rsp_output_proof?.benchmark_run_id === row.benchmark_run_id, 'Accepted RSP output benchmark run id does not match the current run');
    requireCheck(typeof row.rsp_output_proof?.query_hash === 'string' && row.rsp_output_proof.query_hash.length > 0, 'Accepted RSP output query hash is missing');
    requireCheck(row.alert_rsp_proof?.derived_from === 'rsp-query-result', 'PANDA alert log did not prove RSP-derived origin');
    requireCheck(row.alert_rsp_proof?.benchmark_run_id === row.benchmark_run_id, 'PANDA alert log benchmark run id does not match the current run');
    if (typeof row.rsp_output_proof?.query_hash === 'string') {
      requireCheck(row.alert_rsp_proof?.rsp_query_hash === row.rsp_output_proof.query_hash, 'PANDA alert log query hash does not match the accepted RSP output');
    }
    requireCheck(row.log_proof?.validation_basis === 'live_log_growth_after_preflight', 'ODRL proof must come from live post-run log growth');
    requireCheck(isFiniteNumber(row.log_proof?.live_growth_bytes) && row.log_proof.live_growth_bytes > 0, 'ODRL log live_growth_bytes must be > 0');
    requireCheck(m.query_registration_to_first_rsp_output_ms >= row.query_window_seconds * 1000 * 0.8, 'query_registration_to_first_rsp_output_ms is too short for the configured RSP window');
    for (const metric of Object.keys(m)) {
      requireCheck(Boolean(definitions[metric]), `missing metric_definitions entry for ${metric}`);
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
