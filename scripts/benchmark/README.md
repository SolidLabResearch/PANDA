# Benchmark Harness

This harness measures end-to-end latency from posting a webhook notification to PANDA until a websocket response is received from the aggregator.

## Files

- `webhook_latency_benchmark.js`: benchmark runner
- `benchmark.query.rspql.example`: example websocket query payload

## Required setup

1. Start the PANDA server on `http://localhost:8080/`.
2. Start CSS on `http://localhost:3000/` with notifications enabled.
3. Ensure `PANDA_MONITOR_LOG_FILE` points to the PANDA log file so sanity markers can be verified.
4. The benchmark will auto-register webhook preflight on `.notifications/WebhookChannel2023/`, run one sanity POST on `/alice/acc-x/`, and fail fast unless PANDA logs:
   - `webhook_notification_data_received`
   - `webhook_notification_received`
   - `webhook_notification_emitting_topic`

## Example

```bash
mkdir -p benchmark-input
cp scripts/benchmark/benchmark.query.rspql.example benchmark-input/benchmark.query.rspql

QUERY_FILE=$PWD/benchmark-input/benchmark.query.rspql \
PANDA_MONITOR_LOG_FILE=$PWD/benchmark-results/panda-unified-trace-live-latest.stdout.log \
REPLAY_POST_URL=http://localhost:3000/alice/acc-x/ \
ITERATIONS=30 \
WARMUP_ITERATIONS=5 \
node scripts/benchmark/webhook_latency_benchmark.js
```

## Outputs

The runner writes:

- a per-iteration CSV in `benchmark-results/`
- a JSON summary with average latency, p95 latency, and throughput
- stdout sections for:
  - webhook registration response
  - sanity notification proof
  - benchmark raw rows

## UMA + ODRL flow benchmark

Use `uma_odrl_flow_benchmark.js` to measure protected-resource access latency with CSS + UMA, including UMA challenge, token exchange (UMA or ODRL payload), and authorized resource request.

### Quick start (protected UMA target)

```bash
PANDA_UMA_RESOURCE="http://localhost:3000/ruben/private/derived/age" \
PANDA_UMA_CLAIM_TOKEN="http://localhost:3000/alice/profile/card#me" \
ITERATIONS=30 \
WARMUP_ITERATIONS=5 \
npm run benchmark:uma-odrl
```

By default the script enforces UMA flow validity: if the target is publicly readable, it fails fast instead of producing misleading numbers. Override only when explicitly needed:

```bash
PANDA_UMA_REQUIRE_UMA_CHALLENGE=false npm run benchmark:uma-odrl
```

For local demo stacks (`localhost:3000`), the benchmark now auto-heals broken demo storage before failing on a missing UMA header. Disable this only when you need strict pre-heal diagnostics:

```bash
PANDA_UMA_AUTO_HEAL_LOCAL_STACK=false npm run benchmark:uma-odrl
```

Local auto-heal also refreshes PAT credentials for the resource owner account. Defaults are aimed at the demo (`ruben@example.org` / `abc123`, AS `http://localhost:4000/uma`) and can be overridden:

```bash
PANDA_UMA_OWNER_EMAIL="ruben@example.org" \
PANDA_UMA_OWNER_PASSWORD="abc123" \
PANDA_UMA_AUTH_SERVER="http://localhost:4000/uma" \
npm run benchmark:uma-odrl
```

### ODRL request mode

```bash
PANDA_UMA_RESOURCE="http://localhost:3000/ruben/medical/smartwatch.ttl" \
PANDA_UMA_TOKEN_REQUEST_MODE="odrl" \
PANDA_UMA_ODRL_ASSIGNER="http://localhost:3000/ruben/profile/card#me" \
PANDA_UMA_ODRL_ASSIGNEE="http://localhost:3000/alice/profile/card#me" \
PANDA_UMA_CLAIM_TOKEN_FORMAT="urn:solidlab:uma:claims:formats:jwt" \
PANDA_UMA_CLAIM_TOKEN="<jwt-claim-token>" \
ITERATIONS=30 \
WARMUP_ITERATIONS=5 \
npm run benchmark:uma-odrl
```

Or provide a full token request payload file (the script injects `ticket` and `grant_type`):

```bash
PANDA_UMA_RESOURCE="http://localhost:3000/ruben/medical/smartwatch.ttl" \
PANDA_UMA_TOKEN_REQUEST_FILE="$PWD/scripts/benchmark/uma.token.request.odrl.example.json" \
npm run benchmark:uma-odrl
```

### Include policy creation in each iteration (optional)

```bash
PANDA_UMA_INCLUDE_POLICY_POST=true \
PANDA_UMA_POLICY_CONTAINER="http://localhost:3000/ruben/settings/policies/" \
PANDA_UMA_POLICY_FILE="$PWD/scripts/uma/accessAccData.nt" \
PANDA_UMA_POLICY_CONTENT_TYPE="text/turtle" \
npm run benchmark:uma-odrl
```

### Output metrics

The summary JSON and CSV include:

- `initial_challenge_latency_ms`: tokenless request latency until UMA challenge
- `token_exchange_latency_ms`: token endpoint latency
- `authorized_request_latency_ms`: latency of the request with RPT access token
- `total_flow_latency_ms`: end-to-end latency for one UMA authorization cycle
- `policy_post_latency_ms`: optional policy POST latency

## Live websocket registration benchmark

Use `benchmark_live_registration.js` to measure the live registration path from websocket client send to first websocket result received.

### What it measures

- `ws_connect_ms`: TCP/websocket connect to PANDA
- `registration_send_to_ack_ms`: request send until explicit benchmark ack from PANDA
- `registration_send_to_first_message_ms`: request send until first aggregation or alert message arrives
- `first_message_server_timestamp_to_client_receive_ms`: PANDA send timestamp to client receive timestamp
- `rsp_window_wait_ms`: PANDA query registration to first RSP window evaluation completion
- `rule_eval_ms`: first EYE rule evaluation duration for the first emitted result
- `uma_challenge_ms`: tokenless protected GET latency until UMA challenge response
- `uma_token_exchange_ms`: UMA token endpoint latency
- `uma_protected_get_ms`: latency of the authorized protected GET
- `total_uma_grant_ms`: total UMA overhead for the measured authorization cycle
- `total_client_observed_ms`: client connect start to first result receive

Interpretation:

- UMA overhead is `uma_challenge_ms + uma_token_exchange_ms + uma_protected_get_ms`, or directly `total_uma_grant_ms`
- RSP/window waiting is primarily `rsp_window_wait_ms`
- EYE/rule evaluation is `rule_eval_ms`

### Required server mode

Start PANDA with benchmark timing enabled:

```bash
BENCHMARK_TIMING=1 npm start
```

The benchmark ack and server-side timestamps are emitted only in this mode. Normal PANDA behavior stays unchanged when the flag is unset.

### Stack startup

1. Start CSS/UMA without wiping existing file-backed storage.
2. Start PANDA with `BENCHMARK_TIMING=1`.
3. Ensure the monitored stream `http://localhost:3000/alice/spo2/` already exists and continues producing live events.

### Run

```bash
node scripts/benchmark/benchmark_live_registration.js --runs 30 --warmup 5
```

Or:

```bash
npm run benchmark:live-registration -- --runs 30 --warmup 5
```

If PANDA is already running and you want a single wrapper that waits for PANDA readiness, starts the replayer, and then starts the benchmark:

```bash
npm run benchmark:live-registration:with-replayer -- --runs 30 --warmup 5
```

Useful flags:

- `--skip-replayer`: benchmark only, do not start the external replayer
- `--panda-http-url http://localhost:8080/`: change PANDA readiness URL
- `--replayer-repo "/absolute/path/to/policy-aware-decentralized-stream-replayer"`: override replayer repo path
- `REPLAYER_REPO=/absolute/path/to/policy-aware-decentralized-stream-replayer`: env override for replayer repo path

Outputs:

- `benchmark-results/live-registration-benchmark-<timestamp>.jsonl`: one JSON object per run
- `benchmark-results/live-registration-benchmark-<timestamp>.summary.json`: aggregated statistics

Each JSONL row contains phase markers so you can distinguish:

- cold warmup runs vs measured runs
- repeated websocket registrations across runs
- cached token/RPT reuse through `used_stored_token` and `used_cached_rpt`
- repeated messages within the same registration via `extra_message_count_after_first`

### Detailed latency tracing

Enable per-step tracing (JSON-serializable) with:

```bash
UMA_TRACE_TIMINGS=1 npm run benchmark:uma-odrl
```

This writes additional files next to the regular summary:

- `*.trace.ndjson`: one object per iteration with all timed steps and HTTP calls
- `*.steps.summary.json`: aggregated step stats (avg/p95/min/max and repetition rate)

Useful toggles:

- `DEBUG_UMA_LATENCY=1`: alias for `UMA_TRACE_TIMINGS=1`
- `PANDA_UMA_REUSE_ACCESS_TOKEN=true`: first try cached access token before challenge/token exchange (for reuse experiments)


### Strict benchmark with live ODRL log proof

Use the PANDA helper to start UMA with reproducible log capture:

```bash
cd <workspace>/PANDA
npm run uma:start:odrl:logged
# copy the printed export command, then run:
export PANDA_UMA_ODRL_LOG_FILE="/absolute/path/to/panda/benchmark-results/uma-live-logs/uma-odrl-<timestamp>.log"
npm run benchmark:uma-odrl:strict
```

Benchmark sibling-repo defaults (resolved from `<workspace>/PANDA`):

- `RSP-JS`: `<workspace>/RSP-JS`
- `policy-aware-decentralized-stream-replayer`: `<workspace>/policy-aware-decentralized-stream-replayer`
- `user-managed-access`: `<workspace>/user-managed-access`
- `derived-resources-component`: `<workspace>/derived-resources-component`

Override env vars:

- `RSP_JS_REPO`
- `REPLAYER_REPO`
- `UMA_REPO`
- `DERIVED_RESOURCES_REPO`

The strict runner requires live `OdrlAuthorizer` evaluation evidence from `PANDA_UMA_ODRL_LOG_FILE` and fails hard if this proof is missing.

## Scenario runner (`run_all_scenarios.js`)

Use the scenario harness to execute the full scenario matrix and write raw/aggregated outputs under:

- `benchmarks/results/runs/<benchmark-id>/`

### Protected RSP-result scenario

`benchmarks/scenarios/10-uma-replayer-panda-derived-anomaly-e2e.json` now uses the real decentralized stream replayer for elevated heart-rate detection:

- the real replayer posts heart-rate observations to `http://localhost:3000/alice/spo2/`
- PANDA waits for the first full-window result whose rule output is `ELEVATED_HEART_RATE`
- PANDA writes that result to `http://localhost:3000/alice/protected-rsp-results/<benchmark-run-id>.ttl`
- the benchmark runner waits for the Solid notification on that protected resource
- the benchmark completes only after the nurse/caregiver performs the UMA challenge, token exchange, and authorized GET

Protected scenarios must not fall back to `scripts/benchmark/live_spo2_replayer.js`. That script remains only for the baseline scenario and is deprecated there.
The `/alice/spo2/` path is kept here as a transport-compatibility path only; the replayed payload, expected property IRI, rule, and validation semantics are heart-rate.

The protected scenario invokes the real replayer through:

```bash
node scripts/benchmark/run_real_stream_replayer.js \
  --target-url http://localhost:3000/alice/spo2/ \
  --dataset-relative-path data/heart.nt \
  --duration <seconds> \
  --benchmark-run-id <benchmark-run-id> \
  --raw-dir <benchmarks/results/runs/.../raw>
```

The wrapper resolves the repo from `PANDA_STREAM_REPLAYER_REPO_DIR`, defaulting to `../policy-aware-decentralized-stream-replayer`, and also accepts the in-repo checkout used in this workspace. It writes:

- `raw/real-replayer-config-<benchmark-run-id>.json`
- `raw/real-replayer-metadata-<benchmark-run-id>.json`

Required environment variables for the protected benchmark:

- `PANDA_STREAM_REPLAYER_REPO_DIR`: optional override for the real replayer repo path
- `PANDA_UMA_ODRL_LOG_FILE`: required for live ODRL proof validation
- `PANDA_UMA_CLAIM_TOKEN`: claim token used by PANDA and the real replayer
- `PANDA_UMA_CLAIM_TOKEN_FORMAT`: optional, defaults to `urn:solidlab:uma:claims:formats:webid`

The raw result JSON now records protected-resource diagnostics, notification status, ODRL proof status, and the returned protected result body excerpt.

Timing anchors for the protected scenario:

- `query_registered_to_result_received_ms`: WebSocket result path from query registration to the accepted full-window result arriving at the benchmark client.
- `rsp_emit_to_nurse_read_complete_ms`: protected notification/read path from PANDA's accepted full-window RSP emit anchor to nurse read completion.
- `end_to_end_replayer_to_nurse_result_read_ms`: full scenario including the replayer-start offset before query registration.

Legacy compatibility metrics are still emitted, but two names remain ambiguous and should be read carefully:

- `rsp_output_to_panda_result_write_ms` includes both the pre-write delay and the write duration.
- `panda_result_write_to_notification_ms` is now anchored to actual write completion when available; older runs may have approximated this leg from `protected_result.created_at`.

### Resource usage collection (optional, Linux `/proc` based)

Enable per-run resource sampling with:

- `--collect-resource-usage`: enable resource sampler
- `--resource-sample-interval-ms <ms>`: sampling interval (default: `500`)

This writes JSONL samples to:

- `benchmarks/results/runs/<benchmark-id>/raw/resource-samples/*.jsonl`
- `benchmarks/results/runs/<benchmark-id>/warmup/resource-samples/*.jsonl`

Each sample file contains:

- Lifecycle events: `resource_collection_started`, `resource_collection_stopped`
- Actual samples: `event: 'sample'` with `rss_bytes` and `cpu_percent`
- Exit events: `event: 'process_exit'` when a tracked process exits
- Missing PIDs: `event: 'missing_pid'` when a PID is unavailable

Timestamps are relative to sampler start (`timestamp_ms`), with periodic samples every `sample_interval_ms`.

**Smoke run example** (quick test with 3 measured runs per scenario):

```bash
export PANDA_STREAM_REPLAYER_REPO_DIR="/absolute/path/to/policy-aware-decentralized-stream-replayer"
export PANDA_UMA_ODRL_LOG_FILE="/absolute/path/to/uma-odrl-<timestamp>.log"
export PANDA_UMA_CLAIM_TOKEN="http://localhost:3000/bob/profile/card#me"

node scripts/benchmark/run_all_scenarios.js \
  --mode smoke \
  --runs 3 \
  --warmup 0 \
  --only-scenario uma-replayer-panda-derived-anomaly-e2e \
  --collect-resource-usage \
  --resource-sample-interval-ms 500
```

**Full benchmark example** (35 measured runs = 5 scenarios × 7 runs):

```bash
node scripts/benchmark/run_all_scenarios.js \
  --mode full \
  --runs 7 \
  --warmup 0 \
  --collect-resource-usage \
  --resource-sample-interval-ms 500
```

### Aggregation and validation

After benchmarks complete, aggregate results and resource metrics:

```bash
# Aggregate latency and resource metrics into summary.json
node scripts/benchmark/aggregate_results.js --benchmark-id <benchmark-id>

# Validate all runs (non-fatal warnings for missing resource samples)
node scripts/benchmark/validate_results.js --benchmark-id <benchmark-id>

# Validate and require resource samples (fatal if missing)
node scripts/benchmark/validate_results.js --benchmark-id <benchmark-id> --require-resource-samples
```

The aggregation produces `<benchmark-id>/aggregated/summary.json` containing:

- Standard latency metrics across all complete, valid runs
- Resource metrics per process label:
  - `<label>_rss_peak_mb`: peak resident set size
  - `<label>_rss_mean_mb`: mean resident set size
  - `<label>_cpu_mean_percent`: mean CPU utilization
  - `<label>_cpu_peak_percent`: peak CPU utilization
  - `<label>_heap_used_peak_mb`: peak heap usage (if sampled)

**Example smoke run with aggregation:**

```bash
# Run scenarios with resource collection
node scripts/benchmark/run_all_scenarios.js \
  --mode smoke \
  --runs 3 \
  --warmup 0 \
  --collect-resource-usage \
  --resource-sample-interval-ms 500

# Aggregate and validate (replace <benchmark-id> with actual value)
BENCHMARK_ID=$(ls -t benchmarks/results/runs | head -1)
node scripts/benchmark/aggregate_results.js --benchmark-id "$BENCHMARK_ID"
node scripts/benchmark/validate_results.js --benchmark-id "$BENCHMARK_ID"

# View summary
cat "benchmarks/results/runs/$BENCHMARK_ID/aggregated/summary.json" | jq .resource_metrics
```

### Scenario matrix runner

Run a reproducible benchmark matrix:

```bash
PANDA_UMA_RESOURCE="http://localhost:3000/ruben/medical/smartwatch.ttl" \
PANDA_UMA_CLAIM_TOKEN="http://localhost:3000/alice/profile/card#me" \
npm run benchmark:uma-odrl:matrix
```

It produces:

- `benchmark-results/uma-latency-matrix-<timestamp>/matrix.summary.json`
- `benchmark-results/uma-latency-matrix-<timestamp>/matrix.csv`

By default it compares:

- simple UMA request vs complex ODRL request
- cold (`WARMUP_ITERATIONS=0`) vs warm runs
- token reuse off vs on
- localhost vs distributed endpoints

Distributed case is skipped until both are set:

- `PANDA_UMA_RESOURCE_DISTRIBUTED`
- `PANDA_UMA_AUTH_SERVER_DISTRIBUTED`

Optional for matrix complex scenario:

- `PANDA_UMA_COMPLEX_ODRL_REQUEST_FILE` (if omitted, matrix uses built-in ODRL mode payload generation)
