#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  BENCHMARK_NAME,
  POLICY_COUNTS,
  DEFAULT_OWNER_WEBID,
  DEFAULT_REQUESTER_WEBID,
  DEFAULT_TARGET,
  DEFAULT_ACTION,
  generatedPolicyDirectory,
  generatedManifestPath,
  writeGeneratedPolicySet,
} = require('./odrl_policy_graph_size_shared');

function parseArgs(argv) {
  const out = {
    counts: POLICY_COUNTS,
    ownerWebId: process.env.PANDA_UMA_POLICY_OWNER_WEBID || DEFAULT_OWNER_WEBID,
    requesterWebId: process.env.PANDA_UMA_CLAIM_TOKEN || DEFAULT_REQUESTER_WEBID,
    target: process.env.PANDA_UMA_RESOURCE || DEFAULT_TARGET,
    action: DEFAULT_ACTION,
    allowTypeE: (process.env.PANDA_ODRL_BENCH_ALLOW_TYPE_E || 'true').toLowerCase() !== 'false',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--counts' && next) {
      out.counts = next.split(',').map((value) => Number(value.trim())).filter(Number.isFinite);
    }
    if (key === '--requester' && next) out.requesterWebId = next;
    if (key === '--target' && next) out.target = next;
    if (key === '--owner' && next) out.ownerWebId = next;
    if (key === '--allow-type-e' && next) out.allowTypeE = next.toLowerCase() !== 'false';
  }
  return out;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const opts = parseArgs(process.argv.slice(2));
  const generated = [];
  for (const benchmarkPolicyCount of opts.counts) {
    const result = writeGeneratedPolicySet({
      repoRoot,
      benchmarkPolicyCount,
      requesterWebId: opts.requesterWebId,
      target: opts.target,
      action: opts.action,
      ownerWebId: opts.ownerWebId,
      allowTypeE: opts.allowTypeE,
    });
    generated.push({
      benchmark_policy_count: benchmarkPolicyCount,
      file_path: result.filePath,
      matching_benchmark_policies: result.matchingCount,
    });
  }

  const manifest = {
    benchmark_name: BENCHMARK_NAME,
    generated_at: new Date().toISOString(),
    output_directory: generatedPolicyDirectory(repoRoot),
    requester_webid: opts.requesterWebId,
    owner_webid: opts.ownerWebId,
    target: opts.target,
    action: opts.action,
    allow_type_e_distractors: opts.allowTypeE,
    counts: generated,
  };
  fs.mkdirSync(path.dirname(generatedManifestPath(repoRoot)), { recursive: true });
  fs.writeFileSync(generatedManifestPath(repoRoot), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
