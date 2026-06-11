#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function boolEnv(name, fallback = false) {
  return ['1', 'true', 'yes', 'on'].includes(env(name, String(fallback)).toLowerCase());
}

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function latestSummaryPath(outputDir, prefix) {
  const files = fs.readdirSync(outputDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith('.summary.json'))
    .map((file) => ({
      file,
      mtime: fs.statSync(path.join(outputDir, file)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length ? path.join(outputDir, files[0].file) : null;
}

function scenarioDefinitions(baseConfig) {
  const distributedResource = process.env.PANDA_UMA_RESOURCE_DISTRIBUTED || '';
  const distributedAuthServer = process.env.PANDA_UMA_AUTH_SERVER_DISTRIBUTED || '';

  const shared = {
    PANDA_UMA_RESOURCE: baseConfig.resource,
    PANDA_UMA_CLAIM_TOKEN: baseConfig.claimToken,
    PANDA_UMA_AUTH_SERVER: baseConfig.authServer,
    PANDA_UMA_REQUIRE_UMA_CHALLENGE: 'true',
    PANDA_UMA_TOKEN_REQUEST_MODE: 'uma',
    PANDA_UMA_REUSE_ACCESS_TOKEN: 'false',
    PANDA_UMA_AUTO_HEAL_LOCAL_STACK: env('PANDA_UMA_AUTO_HEAL_LOCAL_STACK', 'true'),
    UMA_TRACE_TIMINGS: baseConfig.traceTimings ? '1' : '0',
    ITERATIONS: String(baseConfig.iterations),
    INTER_ITERATION_DELAY_MS: String(baseConfig.interIterationDelayMs),
  };

  const odrlRequestFile = env('PANDA_UMA_COMPLEX_ODRL_REQUEST_FILE', '');

  return [
    {
      id: 'simple_localhost_warm',
      group: 'simple-vs-complex',
      description: 'Simple UMA ticket request, localhost, warm run.',
      env: {
        ...shared,
        WARMUP_ITERATIONS: String(baseConfig.warmupIterations),
        PANDA_UMA_TOKEN_REQUEST_MODE: 'uma',
        PANDA_UMA_TOKEN_REQUEST_FILE: '',
      },
    },
    {
      id: 'complex_localhost_warm',
      group: 'simple-vs-complex',
      description: 'Complex ODRL token request from JSON file, localhost, warm run.',
      env: {
        ...shared,
        WARMUP_ITERATIONS: String(baseConfig.warmupIterations),
        PANDA_UMA_TOKEN_REQUEST_MODE: 'odrl',
        PANDA_UMA_TOKEN_REQUEST_FILE: odrlRequestFile,
      },
    },
    {
      id: 'simple_localhost_cold',
      group: 'cold-vs-warm',
      description: 'Simple UMA request, cold run (no warmup iterations).',
      env: {
        ...shared,
        WARMUP_ITERATIONS: '0',
      },
    },
    {
      id: 'simple_localhost_warm_compare',
      group: 'cold-vs-warm',
      description: 'Simple UMA request, warm run (configured warmup iterations).',
      env: {
        ...shared,
        WARMUP_ITERATIONS: String(baseConfig.warmupIterations),
      },
    },
    {
      id: 'simple_localhost_no_reuse',
      group: 'reuse-vs-no-reuse',
      description: 'Simple UMA request without token reuse.',
      env: {
        ...shared,
        WARMUP_ITERATIONS: String(baseConfig.warmupIterations),
        PANDA_UMA_REUSE_ACCESS_TOKEN: 'false',
      },
    },
    {
      id: 'simple_localhost_reuse',
      group: 'reuse-vs-no-reuse',
      description: 'Simple UMA request with token reuse enabled.',
      env: {
        ...shared,
        WARMUP_ITERATIONS: String(baseConfig.warmupIterations),
        PANDA_UMA_REUSE_ACCESS_TOKEN: 'true',
      },
    },
    {
      id: 'simple_distributed_no_reuse',
      group: 'localhost-vs-distributed',
      description: 'Simple UMA request against distributed endpoints (no token reuse).',
      skip: !distributedResource || !distributedAuthServer,
      skip_reason: !distributedResource || !distributedAuthServer
        ? 'Set PANDA_UMA_RESOURCE_DISTRIBUTED and PANDA_UMA_AUTH_SERVER_DISTRIBUTED.'
        : undefined,
      env: {
        ...shared,
        WARMUP_ITERATIONS: String(baseConfig.warmupIterations),
        PANDA_UMA_RESOURCE: distributedResource,
        PANDA_UMA_AUTH_SERVER: distributedAuthServer,
        PANDA_UMA_AUTO_HEAL_LOCAL_STACK: 'false',
      },
    },
  ];
}

function pickMetrics(summary = {}) {
  return {
    avg_total_flow_latency_ms: summary.avg_total_flow_latency_ms ?? null,
    p95_total_flow_latency_ms: summary.p95_total_flow_latency_ms ?? null,
    avg_initial_challenge_latency_ms: summary.avg_initial_challenge_latency_ms ?? null,
    avg_token_exchange_latency_ms: summary.avg_token_exchange_latency_ms ?? null,
    avg_authorized_request_latency_ms: summary.avg_authorized_request_latency_ms ?? null,
    avg_http_round_trips: summary.phase_breakdown?.avg_http_round_trips ?? null,
    avg_network_ms: summary.phase_breakdown?.avg_network_ms ?? null,
    avg_cpu_ms: summary.phase_breakdown?.avg_cpu_ms ?? null,
  };
}

function runScenario(outputDir, scenario) {
  if (scenario.skip) {
    return {
      id: scenario.id,
      group: scenario.group,
      description: scenario.description,
      status: 'skipped',
      reason: scenario.skip_reason || 'Skipped by configuration.',
    };
  }

  const outputPrefix = `uma-matrix-${scenario.id}`;
  const cmdEnv = {
    ...process.env,
    OUTPUT_DIR: outputDir,
    OUTPUT_PREFIX: outputPrefix,
    ...scenario.env,
  };

  const proc = spawnSync('node', ['scripts/benchmark/uma_odrl_flow_benchmark.js'], {
    cwd: process.cwd(),
    env: cmdEnv,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (proc.status !== 0) {
    return {
      id: scenario.id,
      group: scenario.group,
      description: scenario.description,
      status: 'failed',
      error: (proc.stderr || proc.stdout || '').trim() || `exit code ${proc.status}`,
    };
  }

  const summaryPath = latestSummaryPath(outputDir, outputPrefix);
  if (!summaryPath) {
    return {
      id: scenario.id,
      group: scenario.group,
      description: scenario.description,
      status: 'failed',
      error: 'Benchmark finished but summary file was not found.',
    };
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  return {
    id: scenario.id,
    group: scenario.group,
    description: scenario.description,
    status: 'ok',
    summary_path: summaryPath,
    metrics: pickMetrics(summary),
  };
}

function writeCsv(pathname, rows) {
  const header = [
    'id',
    'group',
    'status',
    'avg_total_flow_latency_ms',
    'p95_total_flow_latency_ms',
    'avg_initial_challenge_latency_ms',
    'avg_token_exchange_latency_ms',
    'avg_authorized_request_latency_ms',
    'avg_http_round_trips',
    'avg_network_ms',
    'avg_cpu_ms',
    'summary_path',
    'note',
  ];

  const lines = rows.map((row) => [
    row.id,
    row.group,
    row.status,
    row.metrics?.avg_total_flow_latency_ms ?? '',
    row.metrics?.p95_total_flow_latency_ms ?? '',
    row.metrics?.avg_initial_challenge_latency_ms ?? '',
    row.metrics?.avg_token_exchange_latency_ms ?? '',
    row.metrics?.avg_authorized_request_latency_ms ?? '',
    row.metrics?.avg_http_round_trips ?? '',
    row.metrics?.avg_network_ms ?? '',
    row.metrics?.avg_cpu_ms ?? '',
    row.summary_path || '',
    JSON.stringify(row.reason || row.error || row.description || ''),
  ].join(','));

  fs.writeFileSync(pathname, `${header.join(',')}\n${lines.join('\n')}\n`);
}

function main() {
  const baseConfig = {
    resource: env('PANDA_UMA_RESOURCE', 'http://localhost:3000/ruben/private/derived/age'),
    claimToken: env('PANDA_UMA_CLAIM_TOKEN', 'http://localhost:3000/alice/profile/card#me'),
    authServer: env('PANDA_UMA_AUTH_SERVER', 'http://localhost:4000/uma'),
    iterations: Number(env('MATRIX_ITERATIONS', env('ITERATIONS', '20'))),
    warmupIterations: Number(env('MATRIX_WARMUP_ITERATIONS', env('WARMUP_ITERATIONS', '5'))),
    interIterationDelayMs: Number(env('MATRIX_INTER_ITERATION_DELAY_MS', env('INTER_ITERATION_DELAY_MS', '150'))),
    traceTimings: boolEnv('MATRIX_TRACE_TIMINGS', boolEnv('UMA_TRACE_TIMINGS', true)),
  };

  const matrixId = nowId();
  const outputDir = env('MATRIX_OUTPUT_DIR', path.join(process.cwd(), 'benchmark-results', `uma-latency-matrix-${matrixId}`));
  fs.mkdirSync(outputDir, { recursive: true });

  const scenarios = scenarioDefinitions(baseConfig);
  const results = scenarios.map((scenario) => runScenario(outputDir, scenario));
  const summaryPath = path.join(outputDir, 'matrix.summary.json');
  const csvPath = path.join(outputDir, 'matrix.csv');
  const manifest = {
    matrix_id: matrixId,
    generated_at: new Date().toISOString(),
    output_dir: outputDir,
    base_config: baseConfig,
    scenarios: results,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeCsv(csvPath, results);

  const printable = {
    matrix_id: matrixId,
    output_dir: outputDir,
    summary_path: summaryPath,
    csv_path: csvPath,
    scenario_status: results.map((row) => ({ id: row.id, status: row.status })),
  };
  console.log(JSON.stringify(printable, null, 2));
}

main();
