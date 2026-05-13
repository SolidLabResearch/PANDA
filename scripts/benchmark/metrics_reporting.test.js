const path = require('path');
const { buildSummary } = require('./aggregate_results');
const { validate } = require('./validate_results');

function loadReferenceRow() {
  // Use the passing protected smoke artifact as the fixture baseline.
  // The test augments it with the newer explicit metric fields.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const row = require(path.join(
    __dirname,
    '..',
    '..',
    'benchmarks',
    'results',
    'runs',
    'panda-protected-smoke-2026-05-14c',
    'raw',
    'uma-replayer-panda-derived-anomaly-e2e-run-1.json',
  ));
  return JSON.parse(JSON.stringify(row));
}

function ensureDefinition(row, metric, overrides = {}) {
  row.metric_definitions[metric] = {
    unit: 'ms',
    type: 'direct',
    start_event: 'test_start',
    end_event: 'test_end',
    interpretation: `${metric} test definition`,
    critical_path: true,
    notes: 'test fixture',
    ...overrides,
  };
}

function enrichProtectedMetrics(row) {
  const emitToWriteStart = row.metrics.rsp_output_to_panda_result_write_ms - row.metrics.panda_result_write_total_ms;
  const writeCompleteToNotification = 1216;
  const notificationToReadComplete = 1084.3341250000083;
  row.metrics.rsp_emit_to_protected_write_start_ms = emitToWriteStart;
  row.metrics.protected_write_start_to_complete_ms = row.metrics.panda_result_write_total_ms;
  row.metrics.protected_write_complete_to_notification_ms = writeCompleteToNotification;
  row.metrics.panda_result_write_to_notification_ms = writeCompleteToNotification;
  row.metrics.created_at_to_notification_ms = 2284;
  row.metrics.notification_to_nurse_read_complete_ms = notificationToReadComplete;
  row.metrics.rsp_emit_to_nurse_read_complete_ms =
    row.metrics.rsp_output_to_panda_result_write_ms + writeCompleteToNotification + notificationToReadComplete;
  row.metrics.query_register_to_nurse_read_complete_ms = row.metrics.query_registration_to_nurse_result_read_ms;
  row.metrics.replayer_start_to_nurse_read_complete_ms = row.metrics.end_to_end_replayer_to_nurse_result_read_ms;

  [
    'rsp_emit_to_protected_write_start_ms',
    'protected_write_start_to_complete_ms',
    'protected_write_complete_to_notification_ms',
    'created_at_to_notification_ms',
    'notification_to_nurse_read_complete_ms',
    'rsp_emit_to_nurse_read_complete_ms',
    'query_register_to_nurse_read_complete_ms',
    'replayer_start_to_nurse_read_complete_ms',
  ].forEach((metric) => ensureDefinition(row, metric));

  return row;
}

describe('protected benchmark metric reporting', () => {
  test('validate passes for a protected run with explicit anchors', () => {
    const row = enrichProtectedMetrics(loadReferenceRow());
    expect(validate(row)).toEqual([]);
  });

  test('validate fails when notification is ordered before write completion', () => {
    const row = enrichProtectedMetrics(loadReferenceRow());
    const notification = row.critical_path_timeline.find((event) => event.event === 'nurse_notification_received');
    const writeComplete = row.critical_path_timeline.find((event) => event.event === 'panda_protected_result_written');
    notification.t_relative_ms = writeComplete.t_relative_ms - 1;
    expect(validate(row)).toContain('protected_write_complete must be <= nurse_notification_received');
  });

  test('aggregate summary exposes the protected critical path in order', () => {
    const row = enrichProtectedMetrics(loadReferenceRow());
    const summary = buildSummary([row], 'test-benchmark-id');
    expect(summary.critical_path_metrics_in_order.map((entry) => entry.metric)).toEqual(expect.arrayContaining([
      'rsp_emit_to_protected_write_start_ms',
      'protected_write_start_to_complete_ms',
      'protected_write_complete_to_notification_ms',
      'notification_to_nurse_read_complete_ms',
      'rsp_emit_to_nurse_read_complete_ms',
      'query_register_to_nurse_read_complete_ms',
      'replayer_start_to_nurse_read_complete_ms',
    ]));
    const metrics = summary.critical_path_metrics_in_order.map((entry) => entry.metric);
    expect(metrics.indexOf('rsp_emit_to_protected_write_start_ms')).toBeLessThan(metrics.indexOf('protected_write_start_to_complete_ms'));
    expect(metrics.indexOf('protected_write_start_to_complete_ms')).toBeLessThan(metrics.indexOf('protected_write_complete_to_notification_ms'));
    expect(metrics.indexOf('protected_write_complete_to_notification_ms')).toBeLessThan(metrics.indexOf('notification_to_nurse_read_complete_ms'));
    expect(metrics.indexOf('notification_to_nurse_read_complete_ms')).toBeLessThan(metrics.indexOf('rsp_emit_to_nurse_read_complete_ms'));
  });
});
