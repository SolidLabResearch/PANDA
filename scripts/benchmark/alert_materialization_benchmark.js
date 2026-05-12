#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIO_ID = 'uma-replayer-panda-derived-anomaly-e2e';

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseArgs(argv) {
  const out = { benchmarkId: env('BENCHMARK_ID', '') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--benchmark-id') out.benchmarkId = argv[i + 1];
  }
  return out;
}

function classifyFailure(context) {
  const msg = String(context.error || '').toLowerCase();
  if (context.serviceFailure) return 'environment/service failure';
  if (context.queryRegistration === false) return 'query registration failure';
  if (context.replayerStarted === false) return 'replayer startup failure';
  if (context.wrongSpo2Target === true) return 'wrong SPO2 target path';
  if (context.noAnomalyData === true) return 'no anomaly-triggering data';
  if (context.missingRunIdPropagation === true) return 'missing benchmark_run_id propagation';
  if (context.pandaProofEmissionFailure === true) return 'PANDA proof-emission failure';
  if (context.alertWriteFailure === true) return 'alert write failure';
  if (context.wrongAlertPath === true) return 'wrong alert output path';
  if (msg.includes('econnrefused') || msg.includes('timed out') || msg.includes('network')) return 'environment/service failure';
  return 'other';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.benchmarkId || new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(ROOT, 'benchmark-results', `alert-materialization-${runId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const summaryPath = path.join(outputDir, `alert-materialization-${runId}.summary.json`);
  const logPath = path.join(outputDir, `alert-materialization-${runId}.log`);
  const scenarioRunId = `${runId}-measured-1`;

  const summary = {
    benchmark_name: 'alert-materialization',
    run_id: runId,
    status: 'failed',
    benchmark_run_id: null,
    alert_materialized: false,
    alert_path: null,
    alert_target_url: env('PANDA_ALERT_TARGET', 'http://localhost:3000/alice/derived/anomaly-alert/'),
    alert_contains_current_benchmark_run_id: false,
    panda_wrote_anomaly_alerts: false,
    latest_anomaly_sample: null,
    failure_class: null,
    failure_reason: null,
    lifecycle_raw_path: null,
  };

  const ctx = {};
  try {
    const cmd = [
      'scripts/benchmark/run_all_scenarios.js',
      '--mode', 'smoke',
      '--runs', '1',
      '--warmup', '0',
      '--only-scenario', SCENARIO_ID,
      '--benchmark-id', scenarioRunId,
    ];
    const result = spawnSync('node', cmd, { cwd: ROOT, env: { ...process.env, BENCHMARK_TIMING: '1' }, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    fs.writeFileSync(logPath, [`$ node ${cmd.join(' ')}`, result.stdout || '', result.stderr || '', `[process_exit] code=${result.status ?? 0}`].join('\n'));
    if (result.status !== 0) {
      ctx.serviceFailure = true;
      throw new Error(`run_all_scenarios failed for ${SCENARIO_ID}`);
    }

    const rawPath = path.join(ROOT, 'benchmarks', 'results', 'runs', scenarioRunId, 'raw', `${SCENARIO_ID}-run-1.json`);
    summary.lifecycle_raw_path = rawPath;
    if (!fs.existsSync(rawPath)) {
      ctx.pandaProofEmissionFailure = true;
      throw new Error(`raw output missing: ${rawPath}`);
    }

    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    summary.benchmark_run_id = raw.benchmark_run_id || null;
    summary.latest_anomaly_sample = raw.latest_anomaly_sample || null;
    summary.panda_wrote_anomaly_alerts = raw?.actor_proof?.panda_wrote_anomaly_alerts === true;
    summary.alert_materialized = summary.panda_wrote_anomaly_alerts;
    summary.alert_path = raw?.alert_rsp_proof?.output_path || raw?.alert_rsp_proof?.path || null;

    const target = String(raw?.meta?.spo2_target || raw?.request?.spo2_target || env('PANDA_SPO2_TARGET', 'http://localhost:3000/alice/spo2/'));
    const logTxt = fs.readFileSync(logPath, 'utf8');
    ctx.queryRegistration = /query registration|register/i.test(logTxt) || raw?.actor_proof?.query_registered === true;
    ctx.replayerStarted = /replay started|replayer/i.test(logTxt) || raw?.actor_proof?.replayer_write_through_uma === true;
    ctx.wrongSpo2Target = !target.includes('/alice/spo2/');
    ctx.noAnomalyData = !String(summary.latest_anomaly_sample || '').trim();
    ctx.missingRunIdPropagation = !summary.benchmark_run_id || !String(summary.latest_anomaly_sample || '').includes(summary.benchmark_run_id);
    ctx.alertWriteFailure = summary.panda_wrote_anomaly_alerts !== true;
    ctx.wrongAlertPath = !summary.alert_path;

    summary.alert_contains_current_benchmark_run_id = Boolean(summary.benchmark_run_id)
      && String(summary.latest_anomaly_sample || '').includes(summary.benchmark_run_id)
      && raw?.alert_rsp_proof?.benchmark_run_id === summary.benchmark_run_id;

    if (!ctx.queryRegistration) throw new Error('query registration proof missing');
    if (!ctx.replayerStarted) throw new Error('replayer startup proof missing');
    if (ctx.wrongSpo2Target) throw new Error(`wrong SPO2 target path: ${target}`);
    if (ctx.noAnomalyData) throw new Error('no anomaly-triggering data evidence');
    if (!summary.alert_contains_current_benchmark_run_id) throw new Error('benchmark_run_id propagation proof missing');
    if (!summary.panda_wrote_anomaly_alerts) throw new Error('PANDA alert proof not emitted');
    if (!summary.alert_path) throw new Error('alert output path unknown');

    summary.status = 'ok';
  } catch (error) {
    summary.failure_class = classifyFailure({ ...ctx, error });
    summary.failure_reason = error.message;
  }

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.status === 'ok' ? 0 : 1);
}

main();
