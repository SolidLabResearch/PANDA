#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { repoRoot, workspaceRoot, siblingDefaults } = require('./workspace_paths');

const DEFAULT_STREAM_REPLAYER_REPO = siblingDefaults.replayerRepo;
const IN_REPO_REPLAYER = path.join(repoRoot, 'replayer');
const FALLBACK_WORKSPACE_REPLAYER = path.join(workspaceRoot, 'policy-aware-decentralized-stream-replayer');
const DEFAULT_STREAM_URL = 'http://localhost:3000/alice/heart-rate/';
const DEFAULT_DATASET = 'data/heart.nt';
const DEFAULT_CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';

function parseArgs(argv) {
  const out = {
    benchmarkRunId: null,
    durationSeconds: 120,
    targetUrl: DEFAULT_STREAM_URL,
    datasetRelativePath: DEFAULT_DATASET,
    replayerRepoDir: process.env.PANDA_REPLAYER_REPO_DIR || process.env.PANDA_STREAM_REPLAYER_REPO_DIR || null,
    rawDir: null,
    claimToken: process.env.PANDA_UMA_CLAIM_TOKEN || 'http://localhost:3000/alice/profile/card#me',
    claimTokenFormat: process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT || DEFAULT_CLAIM_TOKEN_FORMAT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--benchmark-run-id') out.benchmarkRunId = next;
    if (key === '--duration') out.durationSeconds = Number(next);
    if (key === '--target-url') out.targetUrl = next;
    if (key === '--dataset-relative-path') out.datasetRelativePath = next;
    if (key === '--replayer-repo-dir') out.replayerRepoDir = next;
    if (key === '--raw-dir') out.rawDir = next;
    if (key === '--claim-token') out.claimToken = next;
    if (key === '--claim-token-format') out.claimTokenFormat = next;
  }
  if (!out.benchmarkRunId) throw new Error('--benchmark-run-id is required');
  if (!out.rawDir) throw new Error('--raw-dir is required');
  return out;
}

function isUsableReplayerRepo(repoDir) {
  if (!repoDir || !fs.existsSync(repoDir)) return false;
  const packageJsonPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return typeof pkg.scripts?.replay === 'string' && pkg.scripts.replay.length > 0;
  } catch (_) {
    return false;
  }
}

function resolveReplayerRepo(cliRepoDir = null) {
  const explicitRepoDir = cliRepoDir || process.env.PANDA_REPLAYER_REPO_DIR || process.env.PANDA_STREAM_REPLAYER_REPO_DIR || null;
  const candidates = [
    explicitRepoDir,
    IN_REPO_REPLAYER,
    DEFAULT_STREAM_REPLAYER_REPO,
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  for (const candidate of candidates) {
    if (isUsableReplayerRepo(candidate)) {
      return candidate;
    }
  }
  const attempted = Array.from(new Set(candidates));
  const lines = [
    '[benchmark-replayer] No usable real stream replayer package found.',
    ...attempted.map((candidate) => `  attempted: ${candidate}`),
    '  usable package requirements: package.json with an npm "replay" script',
    '  overrides: PANDA_REPLAYER_REPO_DIR, PANDA_STREAM_REPLAYER_REPO_DIR, --replayer-repo-dir',
  ];
  throw new Error(lines.join('\n'));
}

function countObservations(datasetPath) {
  const text = fs.readFileSync(datasetPath, 'utf8');
  const matches = text.match(/<https:\/\/saref\.etsi\.org\/core\/measurementMadeBy>/g) || [];
  if (matches.length === 0) {
    throw new Error(`No observations found in dataset ${datasetPath}`);
  }
  return matches.length;
}

function ensureBuilt(repoDir) {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: repoDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build real stream replayer in ${repoDir}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoDir = resolveReplayerRepo(opts.replayerRepoDir);
  const datasetPath = path.resolve(repoDir, opts.datasetRelativePath);
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Real replayer dataset not found at ${datasetPath}`);
  }
  ensureBuilt(repoDir);
  fs.mkdirSync(opts.rawDir, { recursive: true });

  const observationCount = countObservations(datasetPath);
  const frequency = observationCount / opts.durationSeconds;
  const config = {
    streams: [
      {
        location: opts.targetUrl,
        file_location: datasetPath,
      },
    ],
    frequency_event: frequency,
    frequency_buffer: frequency,
    is_ldes: false,
    tree_path: 'https://saref.etsi.org/core/hasTimestamp',
  };
  const configPath = path.join(opts.rawDir, `real-replayer-config-${opts.benchmarkRunId}.json`);
  const metadataPath = path.join(opts.rawDir, `real-replayer-metadata-${opts.benchmarkRunId}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    benchmark_run_id: opts.benchmarkRunId,
    replayer_repo_dir: repoDir,
    resolved_replayer_repo_dir: repoDir,
    dataset_path: datasetPath,
    target_url: opts.targetUrl,
    duration_seconds: opts.durationSeconds,
    observation_count: observationCount,
    computed_frequency_hz: frequency,
    invocation: {
      command: 'npm',
      args: ['run', 'replay'],
    },
    claim_token_format: opts.claimTokenFormat,
    claim_token_supplied: Boolean(opts.claimToken),
    fake_replayer_used: false,
  }, null, 2)}\n`);

  const child = spawnSync('npm', ['run', 'replay'], {
    cwd: repoDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      REPLAYER_CONFIG_PATH: configPath,
      REPLAYER_UMA_BENCHMARK_MODE: '1',
      REPLAYER_UMA_CLAIM_TOKEN: opts.claimToken,
      REPLAYER_UMA_CLAIM_TOKEN_FORMAT: opts.claimTokenFormat,
      REPLAYER_PANDA_WEBHOOK_URL: process.env.PANDA_REPLAYER_WEBHOOK_URL || 'http://localhost:8080/',
      BENCHMARK_RUN_ID: opts.benchmarkRunId,
    },
  });
  process.exit(child.status ?? 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  IN_REPO_REPLAYER,
  FALLBACK_WORKSPACE_REPLAYER,
  isUsableReplayerRepo,
  resolveReplayerRepo,
  parseArgs,
};
