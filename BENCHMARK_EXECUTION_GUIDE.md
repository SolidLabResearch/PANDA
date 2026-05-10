# Protected RSP-Gated Derived-Anomaly Benchmark Execution Guide

## Changes Summary

### Modified Files
1. **scripts/benchmark/run_all_scenarios.js**
   - Enhanced `pollLatestAnomalyForRun()` to capture polling start timestamp
   - Added 6 new timing metrics to decompose the 44-49s gap
   - Added comprehensive metric definitions

2. **scripts/benchmark/validate_results.js**
   - Hardened validation to detect stale latest-anomaly content
   - Added rspQueryHash matching validation
   - Added smoke-test content detection
   - Added new metric validation checks

3. **scripts/benchmark/aggregate_results.js**
   - Updated PREFERRED_METRIC_ORDER to show critical path breakdown
   - Ensures new metrics are properly aggregated

## New Metrics Exposed

The following metrics now expose the previously hidden 44-49s gap:

| Metric | Purpose | Expected Value |
|--------|---------|-----------------|
| `rsp_output_to_panda_alert_write_success_ms` | RSP output to PANDA alert written | ~2600ms |
| `panda_alert_write_success_to_alice_latest_read_start_ms` | Alert written to polling starts | ~40000-50000ms |
| `alice_latest_read_poll_duration_ms` | Polling duration | ~2200ms |
| `panda_alert_write_success_to_alice_latest_read_success_ms` | Total CSS lag + polling | ~44000ms |
| `rsp_output_to_alice_latest_anomaly_success_ms` | RSP to final read complete | ~49000ms |

### Gap Analysis
- **Expected gap source**: CSS/file-system fsync + derived-resources plugin update lag
- **Measurement**: The new metrics separate CSS initialization time from polling time
- **Result**: Decomposition of the 109s end-to-end into:
  - ~60s: RSP query window
  - ~2.6s: PANDA alert write
  - ~44s: CSS/derived-resources update + polling
  - ~2.2s: Final UMA read

## Prerequisite Infrastructure

Before running the benchmark, ensure the following services are running:

### 1. CSS/UMA with Live ODRL Logging
```bash
cd ../solid-conformance-test-suite  # or UMA repo path
npm run uma:start:odrl:logged &
```
This provides:
- CSS at http://localhost:3000/
- UMA at http://localhost:4000/
- Live ODRL logging for proof capture

### 2. PANDA Monitoring Service
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/PANDA
BENCHMARK_TIMING=1 npm run start-monitoring &
```
This starts PANDA at http://localhost:8080/ with:
- Detailed benchmark timing instrumentation
- Anomaly alert processing
- RSP query support

## Benchmark Execution

### Option A: Quick Smoke Test (Recommended First)
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/PANDA
npm run bootstrap:alice
npm run verify:derived-alice
npm run smoke:derived-anomaly-alert
```

This runs preflight checks to ensure all infrastructure is ready.

### Option B: Full Protected Benchmark
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/PANDA

# Run the protected benchmark with new timing metrics
npx node scripts/benchmark/run_all_scenarios.js \
  --only-scenario uma-replayer-panda-derived-anomaly-e2e \
  --mode smoke \
  --runs 1 \
  --warmup 0 \
  --benchmark-id uma-replayer-panda-derived-anomaly-e2e-rsp-gated-$(date +%Y%m%d-%H%M%S)
```

This will:
1. Register the RSP query with PANDA
2. Start the replayer writing SpO2 observations
3. Wait for RSP window to complete (~60s)
4. Detect PANDA alert write in logs
5. Poll latest-anomaly through UMA (with timing breakdown)
6. Validate all proofs (RSP-derived, benchmarkRunId, rspQueryHash)
7. Generate raw result JSON with all new metrics

## Result Validation & Aggregation

### Validate Results
```bash
BENCHMARK_ID="uma-replayer-panda-derived-anomaly-e2e-rsp-gated-20260509-XXXXX"

node scripts/benchmark/validate_results.js --benchmark-id "$BENCHMARK_ID"
```

This validates:
- Latest-anomaly contains current benchmarkRunId
- Latest-anomaly contains `derivedFrom="rsp-query-result"`
- Latest-anomaly rspQueryHash matches accepted RSP output
- Latest-anomaly doesn't come from smoke-test (stale content check)
- ODRL proof comes from live post-run log growth only
- All new metrics are present and valid

### Aggregate Results
```bash
node scripts/benchmark/aggregate_results.js --benchmark-id "$BENCHMARK_ID"
```

This generates:
- `benchmarks/results/runs/$BENCHMARK_ID/aggregated/summary.json`
- Statistical summaries (mean, stddev, median, p95, min, max) for each metric
- Metrics displayed in critical-path order showing the 44s gap breakdown

## Output Files

For benchmark run `uma-replayer-panda-derived-anomaly-e2e-rsp-gated-20260509-XXXXX`:

```
benchmarks/results/runs/
├── uma-replayer-panda-derived-anomaly-e2e-rsp-gated-20260509-XXXXX/
│   ├── raw/
│   │   ├── uma-replayer-panda-derived-anomaly-e2e-run-1.json    # Raw result with all metrics
│   │   ├── panda-run-1.log                                       # PANDA process log
│   │   ├── replayer-*.log                                        # Replayer process log
│   │   └── uma-live-logs/uma-odrl-run-1.log                     # ODRL proof log
│   ├── aggregated/
│   │   └── summary.json                                          # Aggregated metrics
│   └── failures/                                                  # (Empty if validation passed)
```

## Expected Output

### Raw Result (Run 1)
```json
{
  "benchmark_id": "uma-replayer-panda-derived-anomaly-e2e-rsp-gated-20260509-XXXXX",
  "metrics": {
    "end_to_end_replayer_to_rsp_output_ms": 60000,
    "rsp_output_to_panda_alert_write_success_ms": 2600,
    "panda_alert_write_success_to_alice_latest_read_start_ms": 45000,
    "alice_latest_read_poll_duration_ms": 2200,
    "rsp_output_to_alice_latest_anomaly_success_ms": 49800,
    "end_to_end_replayer_to_alice_latest_anomaly_ms": 109800
  },
  "actor_proof": {
    "replayer_wrote_spo2_observations": true,
    "replayer_write_through_uma": true,
    "panda_registered_query": true,
    "current_run_rsp_output_observed": true,
    "panda_wrote_anomaly_alerts": true,
    "alice_read_latest_anomaly": true
  },
  "alert_rsp_proof": {
    "derived_from": "rsp-query-result",
    "benchmark_run_id": "uma-replayer-panda-derived-anomaly-e2e-rsp-gated-20260509-XXXXX",
    "rsp_query_hash": "abc123def456"
  },
  "log_proof": {
    "validation_basis": "live_log_growth_after_preflight",
    "live_growth_bytes": 50000,
    "panda_alert_write": true,
    "alice_latest_read": true
  }
}
```

### Aggregated Summary (After N runs)
```json
{
  "benchmark_id": "uma-replayer-panda-derived-anomaly-e2e-rsp-gated-20260509-XXXXX",
  "complete_valid_runs": 1,
  "metrics": {
    "end_to_end_replayer_to_rsp_output_ms": {
      "n": 1,
      "mean": 60000,
      "median": 60000,
      "p95": 60000
    },
    "panda_alert_write_success_to_alice_latest_read_success_ms": {
      "n": 1,
      "mean": 45000,
      "median": 45000,
      "p95": 45000
    }
  }
}
```

## Troubleshooting

### "latest-anomaly did not contain current-run RSP-derived proof"
This means the CSS/derived-resources hasn't updated the latest-anomaly resource yet. The new metric `panda_alert_write_success_to_alice_latest_read_start_ms` will show the CSS lag. If it exceeds 90s, the polling timeout is hit.

### "PANDA did not write anomaly alert to /alice/derived/anomaly-alert/"
Check:
1. PANDA is running with `BENCHMARK_TIMING=1`
2. RSP query completed successfully (should see ~60s wait)
3. PANDA logs contain `[MEASURE][ALERT] write_success`

### "Replayer did not write SpO2 observations"
Check:
1. CSS is running and reachable at http://localhost:3000/
2. UMA is running and reachable at http://localhost:4000/
3. Alice pod containers were created with proper permissions

## Next Steps After Execution

1. **Analyze the metrics breakdown**:
   - Compare `panda_alert_write_success_to_alice_latest_read_start_ms` across runs
   - This reveals CSS synchronization behavior
   - Optimize PANDA alert write timing if needed

2. **Verify freshness validation**:
   - Check that `latest-anomaly` always contains current-run benchmarkRunId
   - Confirm rspQueryHash matches
   - Ensure ODRL proof comes from post-run log growth

3. **Plan optimization**:
   - If CSS lag is too high, investigate derived-resources plugin
   - Consider prefetching strategies for latest-anomaly
   - Explore batching anomaly alerts

---

**Status**: Ready for benchmark execution
**Build**: ✅ PASS
**Tests**: ✅ 6/6 PASS
**Metrics**: ✅ All new timing metrics integrated
