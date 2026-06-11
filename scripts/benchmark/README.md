# Benchmark Harness

This harness measures end-to-end latency from posting a webhook notification to PANDA until a websocket response is received from the aggregator.

## Files

- `webhook_latency_benchmark.js`: benchmark runner
- `benchmark.query.rspql.example`: example websocket query payload
- `benchmark.targets.txt.example`: example webhook target list

## Required setup

1. Start the PANDA server on `http://localhost:8080/`.
2. Ensure each target in the targets file resolves to a resource that PANDA can fetch through the normal code path.
3. For the UMA run, make sure the `derived` resources trigger the full `ReuseTokenUMAFetcher` flow.
4. For the baseline run, use a public or otherwise directly readable resource path.

## Example

```bash
mkdir -p benchmark-input
cp scripts/benchmark/benchmark.query.rspql.example benchmark-input/benchmark.query.rspql
cp scripts/benchmark/benchmark.targets.txt.example benchmark-input/benchmark.targets.txt

QUERY_FILE=$PWD/benchmark-input/benchmark.query.rspql \
TARGETS_FILE=$PWD/benchmark-input/benchmark.targets.txt \
ITERATIONS=30 \
WARMUP_ITERATIONS=5 \
node scripts/benchmark/webhook_latency_benchmark.js
```

## Outputs

The runner writes:

- a per-iteration CSV in `benchmark-results/`
- a JSON summary with average latency, p95 latency, and throughput

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
