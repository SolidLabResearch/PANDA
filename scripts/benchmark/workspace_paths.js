const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');

const siblingDefaults = {
  rspJsRepo: path.join(workspaceRoot, 'RSP-JS'),
  replayerRepo: path.join(workspaceRoot, 'policy-aware-decentralized-stream-replayer'),
  umaRepo: path.join(workspaceRoot, 'user-managed-access'),
  derivedResourcesRepo: path.join(workspaceRoot, 'derived-resources-component'),
};

function resolveRepoPath({ cliValue, envVarName, defaultPath }) {
  if (cliValue) return path.resolve(cliValue);
  const envValue = process.env[envVarName];
  if (envValue) return path.resolve(envValue);
  return defaultPath;
}

function ensureRepoExists(resolvedPath, { label, envVarName, cliFlagName }) {
  if (fs.existsSync(resolvedPath)) return;
  const lines = [
    `[benchmark-paths] Missing required sibling repository: ${label}`,
    `  expected path: ${resolvedPath}`,
    `  env override: ${envVarName}=<absolute/path>`,
  ];
  if (cliFlagName) {
    lines.push(`  cli override: ${cliFlagName} <absolute/path>`);
  }
  throw new Error(lines.join('\n'));
}

module.exports = {
  repoRoot,
  workspaceRoot,
  siblingDefaults,
  resolveRepoPath,
  ensureRepoExists,
};
