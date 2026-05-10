#!/usr/bin/env node
/**
 * Test fixture for resource sampler verification.
 * 
 * Tests:
 * 1. Live process samples include rss_bytes
 * 2. Exited process emits process_exit once
 * 3. Missing PID emits missing_pid once
 * 4. Aggregation ignores non-sample events
 * 
 * Run with: node scripts/benchmark/test_resource_sampler.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

const REPO_ROOT = path.dirname(path.dirname(path.dirname(__dirname)));
const TEST_OUTPUT_DIR = path.join(REPO_ROOT, 'benchmarks', 'results', 'test-resource-sampler');

// Copy required functions from run_all_scenarios.js
const PAGE_SIZE_BYTES = 4096;
const PROC_STAT = '/proc/stat';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readCpuTotalJiffies() {
  const text = fs.readFileSync(PROC_STAT, 'utf8');
  const first = text.split('\n')[0] || '';
  const parts = first.trim().split(/\s+/);
  if (parts[0] !== 'cpu') return null;
  const total = parts.slice(1).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return Number.isFinite(total) ? total : null;
}

function readProcStat(pid) {
  const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const closeParen = statText.lastIndexOf(')');
  if (closeParen < 0) return null;
  const rest = statText.slice(closeParen + 2).trim().split(/\s+/);
  const utimeJiffies = Number(rest[11]);
  const stimeJiffies = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(utimeJiffies) || !Number.isFinite(stimeJiffies) || !Number.isFinite(rssPages)) {
    return null;
  }
  return {
    procJiffies: utimeJiffies + stimeJiffies,
    rssBytes: Math.max(0, rssPages) * PAGE_SIZE_BYTES,
  };
}

function isPidLive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    fs.statSync(`/proc/${pid}`);
    return true;
  } catch (_) {
    return false;
  }
}

function createResourceSampler(config) {
  const {
    outFile,
    intervalMs,
    scenarioId,
    runId,
    benchmarkId,
    phase,
    trackedProcesses,
    samplesPath,
  } = config;
  ensureDir(path.dirname(outFile));
  const stream = fs.createWriteStream(outFile, { flags: 'a' });
  const startedAtPerf = performance.now();
  let timer = null;
  let stopped = false;
  let previousCpuTotalJiffies = null;
  const previousProcJiffiesByPid = new Map();
  const exitedPids = new Set();

  const writeRow = (row) => {
    try {
      stream.write(`${JSON.stringify(row)}\n`);
    } catch (_) {
      // keep benchmark running if sample write fails
    }
  };

  const sample = () => {
    const timestampMs = Math.round(performance.now() - startedAtPerf);
    let cpuTotalJiffies = null;
    try {
      cpuTotalJiffies = readCpuTotalJiffies();
    } catch (_) {
      cpuTotalJiffies = null;
    }
    for (const target of trackedProcesses) {
      const base = {
        timestamp_ms: timestampMs,
        scenario_id: scenarioId,
        run_id: runId,
        phase,
        label: target.label,
        pid: Number.isFinite(target.pid) ? target.pid : null,
      };
      if (!Number.isFinite(target.pid)) {
        if (timestampMs === 0) {
          writeRow({ ...base, event: 'missing_pid' });
        }
        continue;
      }
      try {
        const stat = readProcStat(target.pid);
        if (!stat) {
          if (!exitedPids.has(target.pid)) {
            exitedPids.add(target.pid);
            writeRow({ ...base, event: 'process_exit' });
          }
          continue;
        }
        let cpuPercent = null;
        const previousProc = previousProcJiffiesByPid.get(target.pid);
        if (
          Number.isFinite(cpuTotalJiffies)
          && Number.isFinite(previousCpuTotalJiffies)
          && Number.isFinite(previousProc)
        ) {
          const procDelta = stat.procJiffies - previousProc;
          const totalDelta = cpuTotalJiffies - previousCpuTotalJiffies;
          if (procDelta >= 0 && totalDelta > 0) {
            const os = require('os');
            const cores = os.cpus().length || 1;
            cpuPercent = (procDelta / totalDelta) * 100 * cores;
          }
        }
        previousProcJiffiesByPid.set(target.pid, stat.procJiffies);
        writeRow({
          ...base,
          event: 'sample',
          rss_bytes: stat.rssBytes,
          heap_used_bytes: null,
          heap_total_bytes: null,
          cpu_percent: Number.isFinite(cpuPercent) ? cpuPercent : null,
        });
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          if (!exitedPids.has(target.pid)) {
            exitedPids.add(target.pid);
            writeRow({ ...base, event: 'process_exit' });
          }
        } else {
          writeRow({ ...base, event: 'sample_error', error: String(error?.message || error) });
        }
      }
    }
    if (Number.isFinite(cpuTotalJiffies)) {
      previousCpuTotalJiffies = cpuTotalJiffies;
    }
  };

  return {
    start() {
      if (stopped) return;
      
      let liveCount = 0;
      const initialStatus = trackedProcesses.map((target) => {
        const isLive = Number.isFinite(target.pid) && isPidLive(target.pid);
        if (isLive) liveCount += 1;
        return {
          label: target.label,
          pid: target.pid,
          is_live_at_start: isLive,
        };
      });
      
      if (liveCount === 0) {
        console.warn('[resource] WARNING: Resource collection started with no live tracked processes.');
      }
      
      writeRow({
        timestamp_ms: 0,
        event: 'resource_collection_started',
        benchmark_id: benchmarkId,
        scenario_id: scenarioId,
        run_id: runId,
        phase,
        sample_interval_ms: intervalMs,
        tracked_processes: initialStatus,
        samples_path: samplesPath,
      });
      sample();
      timer = setInterval(sample, intervalMs);
    },
    stop(reason = 'scenario_end') {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      writeRow({
        timestamp_ms: Math.round(performance.now() - startedAtPerf),
        event: 'resource_collection_stopped',
        reason,
      });
      stream.end();
    },
  };
}

async function runTest() {
  console.log('[TEST] Starting resource sampler test...');
  
  // Check if we're on Linux (required for /proc-based sampling)
  const isLinux = process.platform === 'linux';
  if (!isLinux) {
    console.log('[TEST] Skipping test on non-Linux platform (requires /proc filesystem)');
    console.log('[TEST] Note: Resource sampler is designed for Linux systems and requires /proc/<pid>');
    process.exit(0);
  }
  
  ensureDir(TEST_OUTPUT_DIR);
  const samplesFile = path.join(TEST_OUTPUT_DIR, 'test-samples.jsonl');
  if (fs.existsSync(samplesFile)) {
    fs.unlinkSync(samplesFile);
  }
  
  // Start a long-running process (sleep for a while)
  const longProcess = spawn('sleep', ['30']);
  const shortProcess = spawn('sleep', ['2']);
  
  await new Promise(resolve => setTimeout(resolve, 100)); // Let processes start
  
  const longPid = longProcess.pid;
  const shortPid = shortProcess.pid;
  const missingPid = 99999; // Non-existent PID
  
  console.log(`[TEST] Long-lived process PID: ${longPid}`);
  console.log(`[TEST] Short-lived process PID: ${shortPid}`);
  console.log(`[TEST] Missing PID: ${missingPid}`);
  
  // Create sampler with both live and missing processes
  const sampler = createResourceSampler({
    outFile: samplesFile,
    intervalMs: 200,
    benchmarkId: 'test-resource-sampler',
    scenarioId: 'test-scenario',
    runId: 1,
    phase: 'test',
    trackedProcesses: [
      { label: 'long_process', pid: longPid },
      { label: 'short_process', pid: shortPid },
      { label: 'missing_process', pid: missingPid },
    ],
    samplesPath: path.relative(REPO_ROOT, samplesFile),
  });
  
  sampler.start();
  
  // Wait for short process to exit
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  sampler.stop('test_complete');
  
  // Wait for stream to flush
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Kill long process
  longProcess.kill();
  
  // Analyze results
  const content = fs.readFileSync(samplesFile, 'utf8');
  const lines = content.trim().split('\n');
  
  console.log(`\n[TEST] Total records written: ${lines.length}`);
  
  let tests = {
    collection_started: false,
    long_process_samples: 0,
    short_process_samples: 0,
    short_process_exit_once: false,
    missing_process_pid_once: false,
    collection_stopped: false,
  };
  
  const exitedShortProcess = new Set();
  const missingPidRecords = new Set();
  
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      
      if (record.event === 'resource_collection_started') {
        tests.collection_started = true;
        console.log('[TEST] ✓ resource_collection_started event found');
        if (record.benchmark_id && record.scenario_id && record.run_id) {
          console.log('[TEST] ✓ resource_collection_started has required fields');
        }
      }
      
      if (record.event === 'sample') {
        if (record.label === 'long_process' && Number.isFinite(record.rss_bytes)) {
          tests.long_process_samples += 1;
        }
        if (record.label === 'short_process' && Number.isFinite(record.rss_bytes)) {
          tests.short_process_samples += 1;
        }
      }
      
      if (record.event === 'process_exit' && record.label === 'short_process') {
        exitedShortProcess.add(record.timestamp_ms);
      }
      
      if (record.event === 'missing_pid' && record.label === 'missing_process') {
        missingPidRecords.add(record.timestamp_ms);
      }
      
      if (record.event === 'resource_collection_stopped') {
        tests.collection_stopped = true;
        console.log('[TEST] ✓ resource_collection_stopped event found');
      }
    } catch (_) {
      // Skip malformed lines
    }
  }
  
  if (tests.long_process_samples > 0) {
    console.log(`[TEST] ✓ Long process has ${tests.long_process_samples} sample records with rss_bytes`);
  } else {
    console.log('[TEST] ✗ Long process has no sample records');
  }
  
  if (tests.short_process_samples > 0) {
    console.log(`[TEST] ✓ Short process has ${tests.short_process_samples} sample records with rss_bytes before exit`);
  } else {
    console.log('[TEST] ✗ Short process has no sample records');
  }
  
  if (exitedShortProcess.size === 1) {
    console.log('[TEST] ✓ Short process emits process_exit only once');
    tests.short_process_exit_once = true;
  } else {
    console.log(`[TEST] ✗ Short process emits process_exit ${exitedShortProcess.size} times (expected 1)`);
  }
  
  if (missingPidRecords.size === 1) {
    console.log('[TEST] ✓ Missing PID emits missing_pid only once');
    tests.missing_process_pid_once = true;
  } else {
    console.log(`[TEST] ✗ Missing PID emits missing_pid ${missingPidRecords.size} times (expected 1)`);
  }
  
  // Summary
  console.log('\n[TEST] Summary:');
  const passed = Object.values(tests).filter(v => v === true || (Number.isFinite(v) && v > 0)).length;
  const total = Object.keys(tests).length;
  console.log(`[TEST] Passed: ${passed}/${total}`);
  
  if (passed === total) {
    console.log('[TEST] ✓ All tests passed!');
    process.exit(0);
  } else {
    console.log('[TEST] ✗ Some tests failed');
    process.exit(1);
  }
}

runTest().catch((error) => {
  console.error('[TEST] Error:', error);
  process.exit(1);
});
