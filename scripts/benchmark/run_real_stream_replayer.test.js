const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  IN_REPO_REPLAYER,
  FALLBACK_WORKSPACE_REPLAYER,
  resolveReplayerRepo,
} = require('./run_real_stream_replayer');

function createReplayerRepo(rootDir, name) {
  const repoDir = path.join(rootDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    scripts: {
      replay: 'node dist/index.js replay',
    },
  }, null, 2)}\n`);
  return repoDir;
}

describe('run_real_stream_replayer repo resolution', () => {
  const originalPandaReplayer = process.env.PANDA_REPLAYER_REPO_DIR;
  const originalPandaStreamReplayer = process.env.PANDA_STREAM_REPLAYER_REPO_DIR;

  afterEach(() => {
    if (originalPandaReplayer === undefined) {
      delete process.env.PANDA_REPLAYER_REPO_DIR;
    } else {
      process.env.PANDA_REPLAYER_REPO_DIR = originalPandaReplayer;
    }
    if (originalPandaStreamReplayer === undefined) {
      delete process.env.PANDA_STREAM_REPLAYER_REPO_DIR;
    } else {
      process.env.PANDA_STREAM_REPLAYER_REPO_DIR = originalPandaStreamReplayer;
    }
  });

  test('prefers explicit PANDA_REPLAYER_REPO_DIR over in-repo default', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-replayer-resolution-'));
    const explicitRepo = createReplayerRepo(tempRoot, 'explicit-replayer');
    process.env.PANDA_REPLAYER_REPO_DIR = explicitRepo;
    delete process.env.PANDA_STREAM_REPLAYER_REPO_DIR;

    expect(resolveReplayerRepo()).toBe(path.resolve(explicitRepo));
  });

  test('uses in-repo replayer before workspace fallback', () => {
    delete process.env.PANDA_REPLAYER_REPO_DIR;
    delete process.env.PANDA_STREAM_REPLAYER_REPO_DIR;

    expect(resolveReplayerRepo()).toBe(path.resolve(IN_REPO_REPLAYER));
    expect(path.resolve(IN_REPO_REPLAYER)).not.toBe(path.resolve(FALLBACK_WORKSPACE_REPLAYER));
  });

  test('fails early with a clear error when no usable repo exists', () => {
    const missingPath = path.join(os.tmpdir(), `missing-replayer-${Date.now()}`);
    process.env.PANDA_REPLAYER_REPO_DIR = missingPath;
    process.env.PANDA_STREAM_REPLAYER_REPO_DIR = missingPath;

    const originalExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((targetPath) => {
      const resolved = path.resolve(String(targetPath));
      if (
        resolved === path.resolve(IN_REPO_REPLAYER)
        || resolved === path.resolve(FALLBACK_WORKSPACE_REPLAYER)
        || resolved === path.resolve(missingPath)
        || resolved === path.resolve(path.join(missingPath, 'package.json'))
      ) {
        return false;
      }
      return originalExistsSync(targetPath);
    });

    expect(() => resolveReplayerRepo()).toThrow(/No usable real stream replayer package found/);
    expect(() => resolveReplayerRepo()).toThrow(new RegExp(path.resolve(IN_REPO_REPLAYER).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    fs.existsSync.mockRestore();
  });
});
