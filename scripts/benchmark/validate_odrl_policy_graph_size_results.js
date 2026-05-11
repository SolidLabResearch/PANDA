#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  BENCHMARK_NAME,
  POLICY_COUNTS,
} = require('./odrl_policy_graph_size_shared');

function parseArgs(argv) {
  const out = {
    summaryPath: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--summary' && next) out.summaryPath = path.resolve(next);
  }
  if (!out.summaryPath) {
    throw new Error('--summary is required');
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const summary = readJson(opts.summaryPath);
  const runs = readJsonLines(summary.runs_path || '');
  const failures = [];

  if (summary.benchmark_name !== BENCHMARK_NAME) {
    failures.push(`Unexpected benchmark_name: ${summary.benchmark_name}`);
  }

  const observedCounts = new Set((summary.levels || []).map((level) => Number(level.benchmark_policy_count)));
  for (const required of POLICY_COUNTS) {
    if (!observedCounts.has(required)) {
      failures.push(`Missing benchmark_policy_count level: ${required}`);
    }
  }

  const measuredByCount = new Map();
  for (const row of runs.filter((row) => row.phase === 'measured')) {
    const count = Number(row.benchmark_policy_count);
    if (!measuredByCount.has(count)) measuredByCount.set(count, []);
    measuredByCount.get(count).push(row);
  }

  for (const level of (summary.levels || [])) {
    const count = Number(level.benchmark_policy_count);
    const measuredRows = measuredByCount.get(count) || [];

    if (Number(level.generated_matching_policy_count) !== 1) {
      failures.push(`generated_matching_policy_count != 1 for benchmark_policy_count=${count}`);
    }
    if (Number(level.matching_benchmark_policies_loaded) !== 1) {
      failures.push(`matching_benchmark_policies_loaded != 1 for benchmark_policy_count=${count}`);
    }
    if (Number(level.failed_runs) > 0) {
      failures.push(`failed_runs > 0 for benchmark_policy_count=${count}`);
    }

    for (const row of measuredRows) {
      if (row.outcome !== 'authorized') {
        failures.push(`Run not authorized for benchmark_policy_count=${count}, iteration=${row.iteration}`);
      }
      if (!row.final_protected_get_succeeded || row.authorized_status !== 200) {
        failures.push(`Final protected GET failed for benchmark_policy_count=${count}, iteration=${row.iteration}`);
      }
      if (Number(row.benchmark_policy_count) !== count) {
        failures.push(`Row benchmark_policy_count mismatch for iteration=${row.iteration}: expected ${count}, got ${row.benchmark_policy_count}`);
      }
      if (Number(row.generated_matching_policy_count) !== 1) {
        failures.push(`generated_matching_policy_count mismatch in run for benchmark_policy_count=${count}, iteration=${row.iteration}`);
      }
      if (Number(row.matching_benchmark_policies_loaded) !== 1) {
        failures.push(`matching_benchmark_policies_loaded mismatch in run for benchmark_policy_count=${count}, iteration=${row.iteration}`);
      }
      if (row.observation_checks?.expected === true && row.observation_checks?.passed !== true) {
        failures.push(`Observation processing expected but not passed for benchmark_policy_count=${count}, iteration=${row.iteration}`);
      }
      if (row.requires_unrelated_alert_assertions === true) {
        failures.push(`Run requires unrelated alert assertions for benchmark_policy_count=${count}, iteration=${row.iteration}`);
      }
    }
  }

  if (summary.observation_checks?.expected === true && summary.observation_checks?.passed !== true) {
    failures.push('Summary indicates expected observation checks were not passed.');
  }
  if (summary.requires_unrelated_alert_assertions === true) {
    failures.push('Summary indicates unrelated alert assertions are required.');
  }

  const output = {
    benchmark_name: summary.benchmark_name,
    summary_path: opts.summaryPath,
    runs_path: summary.runs_path || null,
    checked_at: new Date().toISOString(),
    passed: failures.length === 0,
    failures,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(output.passed ? 0 : 1);
}

main();
