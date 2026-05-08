#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const {
  repoRoot,
  siblingDefaults,
  resolveRepoPath,
  ensureRepoExists,
} = require('./workspace_paths');

const DEFAULT_PANDA_HTTP_URL = 'http://localhost:8080/';

function parseArgs(argv) {
  let replayerRepoCli = null;
  const out = {
    pandaHttpUrl: DEFAULT_PANDA_HTTP_URL,
    replayerRepo: siblingDefaults.replayerRepo,
    runs: 30,
    warmup: 5,
    timeoutMs: 120000,
    observeMs: 1000,
    benchmarkScript: path.join(repoRoot, 'scripts', 'benchmark', 'benchmark_live_registration.js'),
    startReplayer: true,
    readinessTimeoutMs: 60000,
    postReadyDelayMs: 2000,
    replayerCommand: 'npm run replay',
    replayerStartDelayMs: 0,
    targetMessageIndex: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--panda-http-url') out.pandaHttpUrl = next;
    if (key === '--replayer-repo') replayerRepoCli = next;
    if (key === '--runs') out.runs = Number(next);
    if (key === '--warmup') out.warmup = Number(next);
    if (key === '--timeout-ms') out.timeoutMs = Number(next);
    if (key === '--observe-ms') out.observeMs = Number(next);
    if (key === '--readiness-timeout-ms') out.readinessTimeoutMs = Number(next);
    if (key === '--post-ready-delay-ms') out.postReadyDelayMs = Number(next);
    if (key === '--replayer-command') out.replayerCommand = next;
    if (key === '--replayer-start-delay-ms') out.replayerStartDelayMs = Number(next);
    if (key === '--target-message-index') out.targetMessageIndex = Number(next);
    if (key === '--skip-replayer') out.startReplayer = false;
  }
  out.replayerRepo = resolveRepoPath({
    cliValue: replayerRepoCli,
    envVarName: 'REPLAYER_REPO',
    defaultPath: siblingDefaults.replayerRepo,
  });
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPanda(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch (_) {
      // keep polling
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for PANDA readiness at ${url} after ${timeoutMs} ms`);
}

function spawnChild(command, args, options = {}) {
  return spawn(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.startReplayer) {
    ensureRepoExists(opts.replayerRepo, {
      label: 'policy-aware-decentralized-stream-replayer',
      envVarName: 'REPLAYER_REPO',
      cliFlagName: '--replayer-repo',
    });
  }
  let closing = false;

  const cleanup = () => {
    if (closing) return;
    closing = true;
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  console.log(`[wait] PANDA readiness ${opts.pandaHttpUrl}`);
  await waitForPanda(opts.pandaHttpUrl, opts.readinessTimeoutMs);
  console.log(`[ready] PANDA responded on ${opts.pandaHttpUrl}`);
  await sleep(opts.postReadyDelayMs);

  console.log(`[start] benchmark runs=${opts.runs} warmup=${opts.warmup}`);
  const benchmarkArgs = [
    opts.benchmarkScript,
    '--runs', String(opts.runs),
    '--warmup', String(opts.warmup),
    '--timeout-ms', String(opts.timeoutMs),
    '--observe-ms', String(opts.observeMs),
    '--target-message-index', String(opts.targetMessageIndex),
  ];
  if (opts.startReplayer) {
    benchmarkArgs.push(
      '--on-ack-command', opts.replayerCommand,
      '--on-ack-cwd', opts.replayerRepo,
      '--on-ack-delay-ms', String(opts.replayerStartDelayMs),
    );
    console.log(`[hook] replayer will start after benchmark ack in ${opts.replayerRepo}`);
  }
  const benchmark = spawnChild('node', benchmarkArgs, {
    cwd: process.cwd(),
  });

  const exitCode = await new Promise((resolve) => {
    benchmark.on('exit', (code) => resolve(code ?? 1));
  });

  cleanup();
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
