#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EPSILON_MS = 1;

function parseArgs(argv) {
  const out = { benchmarkId: null, requireResourceSamples: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--benchmark-id') out.benchmarkId = argv[i + 1];
    if (argv[i] === '--require-resource-samples') out.requireResourceSamples = true;
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
  const isProtectedScenario = row?.scenario_id === 'uma-replayer-panda-derived-anomaly-e2e'
    || row?.benchmark_mode === 'protected_rsp_result'
    || row?.protected_result_flow?.enabled === true;

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

  if (isProtectedScenario) {
    const protectedFlow = row.protected_result_flow || {};
    const body = protectedFlow.returned_body_parsed || {};
    const semantics = row.stream_semantics || {};
    const replayerMetadata = row.replayer_process?.real_replayer_metadata || {};
    requireCheck(protectedFlow.websocket_protected_result?.status === 'written', 'protected result was not written successfully by PANDA');
    requireCheck(typeof protectedFlow.protected_result_url === 'string' && protectedFlow.protected_result_url.length > 0, 'protected_result_url must be recorded');
    requireCheck(!/live_spo2_replayer\.js/.test(String(row.replayer_process?.command || '')), 'fake replayer still used for protected scenario');
    requireCheck(replayerMetadata.fake_replayer_used === false, 'protected scenario did not record real replayer metadata');
    requireCheck(typeof replayerMetadata.replayer_repo_dir === 'string' && replayerMetadata.replayer_repo_dir.length > 0, 'real replayer repo path was not recorded');
    requireCheck(protectedFlow.public_preflight_status !== 200, 'anonymous/public read returned 200 for protected resource');
    requireCheck(protectedFlow.notification_subscription_status === 'subscribed', 'notification subscription did not succeed');
    requireCheck(protectedFlow.notification_received?.matchesExpected === true, 'relevant Solid notification was not observed');
    requireCheck(protectedFlow.odrl_proof?.passed === true, 'live ODRL proof for nurse protected read is missing');
    requireCheck(protectedFlow.nurse_get_status === 200, 'nurse/caregiver authorized GET did not return 200');
    requireCheck(body.benchmarkRunId === row.benchmark_run_id, 'returned protected result body benchmarkRunId does not match current run');
    requireCheck(body.derivedFrom === 'rsp-query-result', 'returned protected result body derivedFrom is not rsp-query-result');
    requireCheck(body.rspQueryHash === row.message_query_hash, 'returned protected result body rspQueryHash does not match accepted RSP output');
    requireCheck(typeof body.sourceEventId === 'string' && body.sourceEventId.length > 0 && body.sourceEventId !== 'unknown', 'returned protected result body sourceEventId is missing or stale');
    requireCheck(typeof body.rspWindowStart === 'string' && typeof body.rspWindowEnd === 'string', 'returned protected result body rspWindowStart/rspWindowEnd missing');
    requireCheck(protectedFlow.stale_content_detected !== true, 'stale protected result content satisfied the benchmark');
    requireCheck(body.alert === 'ELEVATED_HEART_RATE' || JSON.stringify(protectedFlow.websocket_protected_result || {}).includes('ELEVATED_HEART_RATE'), 'elevated heart-rate alert was not present in the accepted RSP result');
    requireCheck(!JSON.stringify(row).includes('SPO2_LOW'), 'old SPO2_LOW rule still present in protected benchmark output');
    requireCheck(semantics.alert_value === 'ELEVATED_HEART_RATE', 'protected scenario semantics did not declare ELEVATED_HEART_RATE');
    requireCheck(semantics.threshold_relation === 'math:greaterThan' && Number(semantics.threshold_value) === 99.9, 'protected scenario semantics did not record heart-rate threshold > 99.9');
    requireCheck(Number(body.actualValue) > 99.9, 'no elevated heart-rate event crossed the > 99.9 threshold in the protected result body');
    requireCheck(isFiniteNumber(m.nurse_result_total_read_ms) && m.nurse_result_total_read_ms > 0, 'nurse_result_total_read_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.end_to_end_replayer_to_nurse_result_read_ms) && m.end_to_end_replayer_to_nurse_result_read_ms > 0, 'end_to_end_replayer_to_nurse_result_read_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.query_registration_to_nurse_result_read_ms) && m.query_registration_to_nurse_result_read_ms > 0, 'query_registration_to_nurse_result_read_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.rsp_emit_to_protected_write_start_ms) && m.rsp_emit_to_protected_write_start_ms >= 0, 'rsp_emit_to_protected_write_start_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.query_register_to_rule_match_ms) && m.query_register_to_rule_match_ms >= 0, 'query_register_to_rule_match_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.rule_evaluation_only_ms) && m.rule_evaluation_only_ms >= 0, 'rule_evaluation_only_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.rule_match_to_alert_materialization_start_ms) && m.rule_match_to_alert_materialization_start_ms >= 0, 'rule_match_to_alert_materialization_start_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.alert_materialization_ms) && m.alert_materialization_ms >= 0, 'alert_materialization_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.alert_materialization_to_protected_write_start_ms) && m.alert_materialization_to_protected_write_start_ms >= 0, 'alert_materialization_to_protected_write_start_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.protected_write_start_to_complete_ms) && m.protected_write_start_to_complete_ms >= 0, 'protected_write_start_to_complete_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.protected_write_complete_to_notification_ms) && m.protected_write_complete_to_notification_ms >= 0, 'protected_write_complete_to_notification_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.notification_to_nurse_read_complete_ms) && m.notification_to_nurse_read_complete_ms >= 0, 'notification_to_nurse_read_complete_ms must exist and be >= 0');
    requireCheck(isFiniteNumber(m.rsp_emit_to_nurse_read_complete_ms) && m.rsp_emit_to_nurse_read_complete_ms > 0, 'rsp_emit_to_nurse_read_complete_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.query_register_to_nurse_read_complete_ms) && m.query_register_to_nurse_read_complete_ms > 0, 'query_register_to_nurse_read_complete_ms must exist and be > 0');
    requireCheck(isFiniteNumber(m.replayer_start_to_nurse_read_complete_ms) && m.replayer_start_to_nurse_read_complete_ms > 0, 'replayer_start_to_nurse_read_complete_ms must exist and be > 0');
    requireCheck(
      !isFiniteNumber(m.panda_result_write_to_notification_ms) || m.panda_result_write_to_notification_ms >= 0,
      'panda_result_write_to_notification_ms must not be negative',
    );
    const writeStart = timelineEvent(row, 'protected_result_write_start');
    const writeComplete = timelineEvent(row, 'panda_protected_result_written');
    const notification = timelineEvent(row, 'nurse_notification_received');
    const nurseReadComplete = timelineEvent(row, 'nurse_result_uma_get_complete');
    const ruleEvalStart = timelineEvent(row, 'rule_eval_started');
    const ruleEvalFinish = timelineEvent(row, 'rule_eval_finished');
    const ruleMatch = timelineEvent(row, 'rule_match_detected');
    const alertMatStart = timelineEvent(row, 'alert_materialization_start');
    const alertMatComplete = timelineEvent(row, 'alert_materialization_complete');
    const challengeComplete = timelineEvent(row, 'nurse_result_uma_challenge_complete');
    const tokenStart = timelineEvent(row, 'nurse_result_token_exchange_start');
    const tokenComplete = timelineEvent(row, 'nurse_result_token_exchange_complete');
    const authorizedStart = timelineEvent(row, 'nurse_result_authorized_get_start');
    const authorizedComplete = timelineEvent(row, 'nurse_result_authorized_get_complete');
    requireCheck(Boolean(ruleEvalStart), 'critical_path_timeline must include rule_eval_started');
    requireCheck(Boolean(ruleEvalFinish), 'critical_path_timeline must include rule_eval_finished');
    requireCheck(Boolean(ruleMatch), 'critical_path_timeline must include rule_match_detected');
    requireCheck(Boolean(alertMatStart), 'critical_path_timeline must include alert_materialization_start');
    requireCheck(Boolean(alertMatComplete), 'critical_path_timeline must include alert_materialization_complete');
    requireCheck(Boolean(writeStart), 'critical_path_timeline must include protected_result_write_start');
    requireCheck(Boolean(writeComplete), 'critical_path_timeline must include panda_protected_result_written');
    requireCheck(Boolean(notification), 'critical_path_timeline must include nurse_notification_received');
    requireCheck(Boolean(nurseReadComplete), 'critical_path_timeline must include nurse_result_uma_get_complete');
    requireCheck(Boolean(challengeComplete), 'critical_path_timeline must include nurse_result_uma_challenge_complete');
    requireCheck(Boolean(tokenStart), 'critical_path_timeline must include nurse_result_token_exchange_start');
    requireCheck(Boolean(tokenComplete), 'critical_path_timeline must include nurse_result_token_exchange_complete');
    requireCheck(Boolean(authorizedStart), 'critical_path_timeline must include nurse_result_authorized_get_start');
    requireCheck(Boolean(authorizedComplete), 'critical_path_timeline must include nurse_result_authorized_get_complete');
    if (ruleEvalStart && ruleEvalFinish) {
      requireCheck(ruleEvalStart.t_relative_ms <= ruleEvalFinish.t_relative_ms, 'rule_eval_started must be <= rule_eval_finished');
    }
    if (ruleEvalFinish && ruleMatch) {
      requireCheck(ruleEvalFinish.t_relative_ms <= ruleMatch.t_relative_ms, 'rule_eval_finished must be <= rule_match_detected');
    }
    if (ruleMatch && alertMatStart) {
      requireCheck(ruleMatch.t_relative_ms <= alertMatStart.t_relative_ms, 'rule_match_detected must be <= alert_materialization_start');
    }
    if (alertMatStart && alertMatComplete) {
      requireCheck(alertMatStart.t_relative_ms <= alertMatComplete.t_relative_ms, 'alert_materialization_start must be <= alert_materialization_complete');
    }
    if (alertMatComplete && writeStart) {
      requireCheck(alertMatComplete.t_relative_ms <= writeStart.t_relative_ms, 'alert_materialization_complete must be <= protected_result_write_start');
    }
    if (writeStart && writeComplete) {
      requireCheck(writeStart.t_relative_ms <= writeComplete.t_relative_ms, 'protected_write_start must be <= protected_write_complete');
    }
    if (writeComplete && notification) {
      requireCheck(writeComplete.t_relative_ms <= notification.t_relative_ms, 'protected_write_complete must be <= nurse_notification_received');
    }
    if (notification && nurseReadComplete) {
      requireCheck(notification.t_relative_ms <= nurseReadComplete.t_relative_ms, 'nurse_notification_received must be <= nurse_result_uma_get_complete');
    }
    if (challengeComplete && tokenStart) {
      requireCheck(challengeComplete.t_relative_ms <= tokenStart.t_relative_ms, 'nurse_result_uma_challenge_complete must be <= nurse_result_token_exchange_start');
    }
    if (tokenStart && tokenComplete) {
      requireCheck(tokenStart.t_relative_ms <= tokenComplete.t_relative_ms, 'nurse_result_token_exchange_start must be <= nurse_result_token_exchange_complete');
    }
    if (tokenComplete && authorizedStart) {
      requireCheck(tokenComplete.t_relative_ms <= authorizedStart.t_relative_ms, 'nurse_result_token_exchange_complete must be <= nurse_result_authorized_get_start');
    }
    if (authorizedStart && authorizedComplete) {
      requireCheck(authorizedStart.t_relative_ms <= authorizedComplete.t_relative_ms, 'nurse_result_authorized_get_start must be <= nurse_result_authorized_get_complete');
    }
    if (authorizedComplete && nurseReadComplete) {
      requireCheck(authorizedComplete.t_relative_ms <= nurseReadComplete.t_relative_ms, 'nurse_result_authorized_get_complete must be <= nurse_result_uma_get_complete');
    }
    if (row.mode === 'smoke' && isFiniteNumber(m.rsp_emit_to_nurse_read_complete_ms)) {
      requireCheck(
        m.rsp_emit_to_nurse_read_complete_ms > 0 && m.rsp_emit_to_nurse_read_complete_ms < 20000,
        'rsp_emit_to_nurse_read_complete_ms is outside the sane smoke-run range (0, 20000)',
      );
    }
  }

  return failures;
}

function buildValidationOutput(rows, opts) {
  const measured = rows.filter(({ row }) => (
    row.phase === 'measured' || (typeof row.run_id === 'number' && row.run_id > 0)
  ));
  const failures = measured
    .map(({ file, row }) => ({ file, row, reasons: validate(row) }))
    .filter(({ reasons }) => reasons.length > 0);
  const resourceSampleWarnings = [];
  for (const { file, row } of measured) {
    const isCompleteValid = row.status === 'complete' && row.output_check?.passed === true;
    if (!isCompleteValid) continue;
    const samplePathRelative = row?.resource_usage?.samples_path;
    const samplePath = typeof samplePathRelative === 'string' && samplePathRelative.length > 0
      ? path.join(ROOT, samplePathRelative)
      : null;
    if (!samplePath) {
      resourceSampleWarnings.push({
        file,
        scenario_id: row.scenario_id,
        run_id: row.run_id,
        warning: 'resource_samples_missing_path',
      });
      continue;
    }
    if (!fs.existsSync(samplePath)) {
      resourceSampleWarnings.push({
        file,
        scenario_id: row.scenario_id,
        run_id: row.run_id,
        warning: 'resource_samples_file_not_found',
        expected_path: samplePathRelative,
      });
      continue;
    }
    const stat = fs.statSync(samplePath);
    if (!stat.isFile() || stat.size === 0) {
      resourceSampleWarnings.push({
        file,
        scenario_id: row.scenario_id,
        run_id: row.run_id,
        warning: 'resource_samples_file_empty',
        expected_path: samplePathRelative,
      });
    }
  }
  const fatalResourceFailures = opts.requireResourceSamples ? resourceSampleWarnings : [];
  const output = {
    benchmark_id: opts.benchmarkId,
    checked_at: new Date().toISOString(),
    total_raw_files: measured.length,
    passed: failures.length === 0 && fatalResourceFailures.length === 0 && measured.length > 0,
    failures: failures.map(({ file, row, reasons }) => ({
      file,
      scenario_id: row.scenario_id,
      run_id: row.run_id,
      status: row.status,
      output_check: row.output_check,
      reasons,
    })),
    warnings: {
      resource_samples: resourceSampleWarnings,
      resource_sample_validation_mode: opts.requireResourceSamples ? 'required_fatal' : 'warn_non_fatal',
    },
  };
  return output;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runRoot = path.join(ROOT, 'benchmarks', 'results', 'runs', opts.benchmarkId);
  const rawDir = path.join(runRoot, 'raw');
  const rows = fs.readdirSync(rawDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, row: JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')) }));
  const output = buildValidationOutput(rows, opts);
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildValidationOutput,
  isFiniteNumber,
  nearlyEqual,
  timelineEvent,
  validate,
};
