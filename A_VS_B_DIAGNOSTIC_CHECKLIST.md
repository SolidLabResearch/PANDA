# Quick A vs B Diagnostic Checklist

## What Changed

Enhanced the polling function to capture **attempt-by-attempt details** with timestamps and content validation results, instead of just aggregate metrics.

## Files Modified

1. **scripts/benchmark/run_all_scenarios.js**
   - Enhanced `pollLatestAnomalyForRun()` to capture first attempt timestamp and attempt history
   - Added `evaluateContentFreshness()` helper function
   - Added 7 new metrics decomposing the polling gap
   - Updated diagnostics structure to include attempt history

2. No changes to CSS, UMA, PANDA, or Replayer
3. No sleeps added, no control-flow delays introduced
4. Validation remains the same (stale content still rejected)

## Quick Interpretation

Run the benchmark once and check **ONE field**:

```bash
cat benchmarks/results/runs/$BENCH_ID/raw/uma-replayer-panda-derived-anomaly-e2e-run-1.json | \
  jq '.metrics.panda_alert_write_success_to_alice_first_poll_attempt_ms'
```

**If this is:**
- **~0-100 ms** → Polling starts immediately. The gap is CSS lag. (**Scenario B**)
- **> 1000 ms** → Polling starts late. Find what control-flow step causes the delay. (**Scenario A**)

## Detailed Interpretation

If you want the full picture, extract this view:

```bash
cat benchmarks/results/runs/$BENCH_ID/raw/uma-replayer-panda-derived-anomaly-e2e-run-1.json | jq '
{
  key_timing: {
    panda_alert_success_to_poll_function_start_ms: .metrics.panda_alert_write_success_to_alice_poll_function_start_ms,
    panda_alert_success_to_first_attempt_ms: .metrics.panda_alert_write_success_to_alice_first_poll_attempt_ms,
    first_attempt_to_success_ms: .metrics.alice_first_poll_attempt_to_latest_anomaly_success_ms,
  },
  polling_summary: {
    attempts: .latest_anomaly_diagnostics.attempts,
    total_elapsed_ms: .latest_anomaly_diagnostics.elapsed_ms,
  },
  first_three_attempts: .latest_anomaly_diagnostics.attempt_history[0:3] | map({
    attempt_num: .attempt_number,
    status: .status_code,
    is_fresh: .is_fresh,
    reasons: .content_validation.reasons,
  }),
  last_attempt: .latest_anomaly_diagnostics.attempt_history[-1] | {
    attempt_num: .attempt_number,
    status: .status_code,
    is_fresh: .is_fresh,
  },
}
'
```

## Scenario B Pattern

If output looks like:

```json
{
  "key_timing": {
    "panda_alert_success_to_poll_function_start_ms": 5,
    "panda_alert_success_to_first_attempt_ms": 8,
    "first_attempt_to_success_ms": 45220
  },
  "polling_summary": {
    "attempts": 92,
    "total_elapsed_ms": 45245
  },
  "first_three_attempts": [
    {
      "attempt_num": 1,
      "status": 404,
      "is_fresh": false,
      "reasons": ["resource_not_found"]
    },
    {
      "attempt_num": 2,
      "status": 200,
      "is_fresh": false,
      "reasons": ["missing_current_benchmark_run_id"]
    },
    {
      "attempt_num": 3,
      "status": 200,
      "is_fresh": false,
      "reasons": ["missing_current_benchmark_run_id"]
    }
  ],
  "last_attempt": {
    "attempt_num": 92,
    "status": 200,
    "is_fresh": true
  }
}
```

**This is Scenario B: CSS derived-resource lag.**

- Polling starts **8ms** after PANDA alert success (immediate)
- CSS returns **404** for initial attempts (resource doesn't exist yet)
- CSS eventually returns **200 with stale content** (different benchmark_run_id)
- After **~45 seconds** and **92 attempts** CSS finally has fresh content
- **Root cause: CSS file-system sync lag, not benchmark code**

## Scenario A Pattern

If output shows `panda_alert_success_to_first_attempt_ms: 45000` (or higher), then something is delaying the polling start. Check the code path between:

```javascript
const pandaAlertSuccessMs = pandaAlertProof.success_ms;  // <-- PANDA done here
// [what happens in between?]
const latest = await pollLatestAnomalyForRun(...);       // <-- polling starts here
```

## New Metric Definitions

| Metric | Meaning | A vs B |
|--------|---------|--------|
| `panda_alert_write_success_to_alice_poll_function_start_ms` | Delay before calling polling function | A: large, B: ~0 |
| `panda_alert_write_success_to_alice_first_poll_attempt_ms` | Delay before first HTTP request | A: large, B: ~0 |
| `alice_first_poll_attempt_to_latest_anomaly_success_ms` | CSS lag + polling duration | A: small, B: large |
| `alice_latest_read_poll_attempt_count` | Number of HTTP attempts | A: ≤5, B: 50+ |
| `alice_latest_read_poll_function_start_ms` | Unix timestamp when polling starts | Diagnostic |
| `alice_latest_read_first_attempt_ms` | Unix timestamp of first HTTP request | Diagnostic |

## Attempt History

The `attempt_history[]` array in diagnostics contains every HTTP attempt with:
- `attempt_number` - which attempt (1-indexed)
- `attempt_time` and `attempt_time_iso` - exact timestamp
- `status_code` - HTTP status
- `is_fresh` - whether content passed validation
- `content_validation.reasons[]` - array of validation failure reasons if not fresh

Common failure reasons:
- `resource_not_found` → CSS hasn't created the resource yet
- `missing_current_benchmark_run_id` → Stale content from previous run
- `missing_rsp_query_hash` → Not properly RSP-derived
- All success when `is_fresh: true`

## Decision Tree

```
Does panda_alert_success_to_first_attempt_ms look reasonable (< 100 ms)?
├─ YES → Polling starts immediately
│   ├─ Are there many attempts (50+)?
│   │   ├─ YES → Early attempts have status 404 or stale content
│   │   │   └─ CONCLUSION: Scenario B (CSS lag)
│   │   └─ NO → Polling succeeds quickly
│   │       └─ Gap is small, no issue
│   └─ NO → This shouldn't happen; check for control-flow async issues
├─ NO → Polling starts LATE (Scenario A)
│   ├─ Look for delays between PANDA completion and polling call
│   └─ Possible causes:
│       ├─ Awaiting unrelated async operation
│       ├─ Waiting for signal/event
│       ├─ Console output/logging overhead
│       └─ Network timeout retry loop
```

## No False Positives

This diagnostic cannot create false positives because:
- ✅ No sleeps added to polling loop
- ✅ No control-flow changes except timestamp capture
- ✅ Validation unchanged (same rejection criteria)
- ✅ Attempt history is factual (actual HTTP requests made)
- ✅ Timestamps come from two sources:
  - Function-start: before first HTTP request
  - Attempt timestamps: from each umaFetchMeasured() call
  - Success time: when validation passes

## Running the Diagnostic

```bash
cd /Users/kushbisen/Code/PANDA Platform/PANDA

# Run preflight checks
npm run bootstrap:alice
npm run verify:derived-alice
npm run smoke:derived-anomaly-alert

# Run the benchmark once with diagnostic
BENCH_ID="polling-diagnostic-$(date +%Y%m%d-%H%M%S)"
npx node scripts/benchmark/run_all_scenarios.js \
  --only-scenario uma-replayer-panda-derived-anomaly-e2e \
  --mode smoke --runs 1 --warmup 0 \
  --benchmark-id "$BENCH_ID"

# Interpret the results
echo "Quick check:"
cat benchmarks/results/runs/$BENCH_ID/raw/uma-replayer-panda-derived-anomaly-e2e-run-1.json | \
  jq '.metrics | "Polling delay before first attempt: " + (.panda_alert_write_success_to_alice_first_poll_attempt_ms | tostring) + " ms"'

# Full view (see JSON structure above)
cat benchmarks/results/runs/$BENCH_ID/raw/uma-replayer-panda-derived-anomaly-e2e-run-1.json | \
  jq '{key_timing: .metrics | {before_function: .panda_alert_write_success_to_alice_poll_function_start_ms, before_attempt: .panda_alert_write_success_to_alice_first_poll_attempt_ms, from_first_to_success: .alice_first_poll_attempt_to_latest_anomaly_success_ms}, attempt_count: .latest_anomaly_diagnostics.attempts}'
```

## Bottom Line

- Build: ✅ Clean, no errors
- Tests: ✅ 6/6 passing
- Backward compatible: ✅ Yes
- False positives: ✅ None — based on actual HTTP attempt facts
- Ready to run: ✅ Yes

Just run the benchmark and check the one field to know if it's A or B.
