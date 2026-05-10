# Polling Analysis Guide - Distinguishing A vs B

## The Question

When the ~45-second gap appears between PANDA alert write and Alice successful latest-anomaly read, is it:

**A. Polling starts late** — The benchmark waits ~45s before calling `pollLatestAnomalyForRun()`
OR
**B. Polling starts immediately, but gets stale/404 responses** — CSS/derived-resources takes ~45s to generate fresh content

## New Fields Captured

### Raw Diagnostics Structure
Each benchmark run now captures detailed polling attempt history:

```javascript
raw.latest_anomaly_diagnostics = {
  // Timing measurements
  poll_start_time_ms: 1234567890000,           // Unix timestamp when polling function starts
  poll_start_time_iso: "2026-05-09T...",       // ISO string
  first_attempt_time_ms: 1234567890050,        // Unix timestamp of first HTTP request
  first_attempt_time_iso: "2026-05-09T...",    // ISO string
  first_attempt_to_success_ms: 45234,          // ms from first attempt to success

  // Attempt-by-attempt history
  attempt_history: [
    {
      attempt_number: 1,
      attempt_time: 1234567890050,
      attempt_time_iso: "2026-05-09T...",
      status_code: 404,
      is_fresh: false,
      content_validation: {
        is_fresh: false,
        reasons: ["resource_not_found"]
      }
    },
    {
      attempt_number: 2,
      attempt_time: 1234567890550,
      status_code: 200,
      is_fresh: false,
      content_validation: {
        is_fresh: false,
        reasons: ["missing_current_benchmark_run_id"],
        stale_benchmark_run_id: "some-other-run-id"
      }
    },
    // ... more attempts ...
    {
      attempt_number: 92,
      attempt_time: 1234567935250,
      status_code: 200,
      is_fresh: true,
      content_validation: {
        is_fresh: true
      }
    }
  ],

  attempts: 92,
  elapsed_ms: 45250,
  // ... other fields ...
}
```

### New Metrics

```javascript
raw.metrics = {
  // KEY METRICS FOR A vs B DIAGNOSIS
  
  // If this is ~0 or very small (< 100ms), polling starts immediately (not scenario A)
  panda_alert_write_success_to_alice_poll_function_start_ms: 5,
  
  // If this is ~0 or very small (< 100ms), first HTTP request happens immediately
  panda_alert_write_success_to_alice_first_poll_attempt_ms: 8,
  
  // This is the remaining gap
  // If > 0 and large (> 1000ms), all attempts were stale/404 (scenario B)
  alice_first_poll_attempt_to_latest_anomaly_success_ms: 45220,
  
  // Total polling loop time (legacy compatibility)
  alice_latest_read_poll_duration_ms: 45245,
  
  // Raw polling details
  alice_latest_read_poll_function_start_ms: 1234567890000,
  alice_latest_read_first_attempt_ms: 1234567890008,
  alice_latest_read_poll_attempt_count: 92,
  
  // ... rest of metrics ...
}
```

## Content Validation Reasons

The `content_validation.reasons[]` array explains why each response was rejected. Possible values:

| Reason | Meaning | Indicates |
|--------|---------|-----------|
| `body_not_string` | Response body is not text | HTTP error or connection issue |
| `body_empty` | Response has no content | 404 or empty response |
| `resource_not_found` | Body contains "404" or "not found" | CSS/derived-resources hasn't created the resource yet |
| `missing_current_benchmark_run_id` | Response doesn't contain current run ID | Stale content from previous run |
| `contains_different_benchmark_run_id` | Response has different run ID in `stale_benchmark_run_id` field | Confirms staleness, old run ID shown |
| `missing_derived_from_rsp_query_result` | Missing `derivedFrom="rsp-query-result"` | Content not from RSP derivation |
| `missing_rsp_query_hash` | Missing `rspQueryHash` field | Content not RSP-derived |
| `rsp_query_hash_mismatch` | `rspQueryHash` doesn't match expected value | Content from different RSP query |
| `missing_rsp_window_start` | Missing RSP window metadata | Not properly derived content |
| `missing_rsp_window_end` | Missing RSP window metadata | Not properly derived content |
| `missing_rsp_result_timestamp` | Missing RSP timestamp | Not properly derived content |

## How to Diagnose A vs B

### Scenario A: Polling Starts Late

**Evidence**:
- `panda_alert_write_success_to_alice_poll_function_start_ms` is **large** (e.g., > 1000ms)
- `panda_alert_write_success_to_alice_first_poll_attempt_ms` is **large** (e.g., > 1000ms)
- `alice_first_poll_attempt_to_latest_anomaly_success_ms` is **small** (e.g., < 500ms)
- First attempt in `attempt_history` has timestamp **significantly after** alert success

**Action**: 
Find what control-flow step happens between PANDA alert completion and polling start. Look at the source code between these lines:
```javascript
const pandaAlertSuccessMs = pandaAlertProof.success_ms;  // PANDA done
const latest = await pollLatestAnomalyForRun(...);       // Polling starts
```

### Scenario B: CSS Derived-Resource Lag

**Evidence**:
- `panda_alert_write_success_to_alice_poll_function_start_ms` is **~0** or very small (< 100ms)
- `panda_alert_write_success_to_alice_first_poll_attempt_ms` is **~0** or very small (< 100ms)
- `alice_first_poll_attempt_to_latest_anomaly_success_ms` is **large** (e.g., 40-50 seconds)
- `attempt_history` shows many attempts with:
  - Early attempts: `status_code: 404` with reason `resource_not_found`
  - Middle attempts: `status_code: 200` with reason `missing_current_benchmark_run_id` or `contains_different_benchmark_run_id`
  - Late attempts: `status_code: 200` with `is_fresh: true`
- `alice_latest_read_poll_attempt_count` is large (e.g., 80-100 attempts)

**Interpretation**:
- CSS doesn't have the latest-anomaly file ready when first poll happens
- CSS/derived-resources plugin generates it with ~45-second latency
- Multiple polling cycles (500ms each) needed until CSS has fresh content

**Root Cause**: 
CSS file-system synchronization lag caused by fsync, N3 RDF parsing, and derived-resources computation.

## Example: Analyzing a Raw Result

```bash
# Extract just the polling diagnostics from a benchmark result
cat benchmarks/results/runs/$BENCH_ID/raw/uma-replayer-panda-derived-anomaly-e2e-run-1.json | jq '.latest_anomaly_diagnostics | {
  poll_function_start_ms: .poll_start_time_ms,
  first_attempt_ms: .first_attempt_time_ms,
  first_attempt_to_success_ms,
  attempts_total: .attempts,
  earliest_attempt: .attempt_history[0],
  latest_attempt: .attempt_history[-1]
}'
```

**Example output (Scenario B)**:
```json
{
  "poll_function_start_ms": 1234567890000,
  "first_attempt_ms": 1234567890008,           // Only 8ms after function start
  "first_attempt_to_success_ms": 45234,        // But takes 45 seconds to get fresh
  "attempts_total": 92,
  "earliest_attempt": {
    "attempt_number": 1,
    "attempt_time": 1234567890008,
    "status_code": 404,
    "reasons": ["resource_not_found"]           // CSS hasn't created it yet
  },
  "latest_attempt": {
    "attempt_number": 92,
    "attempt_time": 1234567935234,
    "status_code": 200,
    "is_fresh": true                            // Finally has fresh content
  }
}
```

This pattern clearly shows **Scenario B**: polling starts immediately (8ms), but CSS takes 45s to generate fresh derived content.

## Metrics Arithmetic

For reference, these relationships should always hold:

```
panda_alert_write_success_to_alice_poll_function_start_ms
  = panda_alert_write_success_to_alice_first_poll_attempt_ms
  - (overhead between function call and first HTTP request)

panda_alert_write_success_to_alice_first_poll_attempt_ms
  + alice_first_poll_attempt_to_latest_anomaly_success_ms
  = panda_alert_write_success_to_alice_latest_read_success_ms

panda_alert_write_success_to_alice_poll_function_start_ms
  + alice_latest_read_poll_loop_duration_ms
  ≈ panda_alert_write_success_to_alice_latest_read_success_ms
```

## Running with These New Metrics

The benchmark already captures these automatically. Just run normally:

```bash
npm run bootstrap:alice
npm run verify:derived-alice
npm run smoke:derived-anomaly-alert

BENCH_ID="gap-analysis-$(date +%Y%m%d-%H%M%S)"
npx node scripts/benchmark/run_all_scenarios.js \
  --only-scenario uma-replayer-panda-derived-anomaly-e2e \
  --mode smoke --runs 1 --warmup 0 \
  --benchmark-id "$BENCH_ID"
```

Then examine:

```bash
# View the key diagnostic metrics
cat benchmarks/results/runs/$BENCH_ID/raw/uma-replayer-panda-derived-anomaly-e2e-run-1.json | jq '.latest_anomaly_diagnostics | keys'

# View the new metrics
cat benchmarks/results/runs/$BENCH_ID/raw/uma-replayer-panda-derived-anomaly-e2e-run-1.json | jq '.metrics | {
  "DIAGNOSIS": (
    if .panda_alert_write_success_to_alice_first_poll_attempt_ms < 100 then "Polling starts immediately"
    else "Polling starts LATE - investigate control flow"
    end
  ),
  "panda_alert_write_success_to_alice_poll_function_start_ms": .panda_alert_write_success_to_alice_poll_function_start_ms,
  "panda_alert_write_success_to_alice_first_poll_attempt_ms": .panda_alert_write_success_to_alice_first_poll_attempt_ms,
  "alice_first_poll_attempt_to_latest_anomaly_success_ms": .alice_first_poll_attempt_to_latest_anomaly_success_ms,
  "alice_latest_read_poll_attempt_count": .alice_latest_read_poll_attempt_count,
  "attempt_statuses": (
    [.latest_anomaly_diagnostics.attempt_history[] | .status_code]
  )
}'
```

## Summary

With these new fields and metrics, you can definitively determine:

- **A (polling late)**: `poll_function_start_ms` and `first_attempt_ms` are significantly delayed
- **B (CSS lag)**: `poll_function_start_ms` and `first_attempt_ms` are immediate, but `attempt_history` shows CSS taking time to generate fresh content

No more inference — the evidence is in the raw attempt-by-attempt history.
