# UMA Benchmark Runbook (Strict)

## 1) Clean startup order
Preferred (reproducible strict benchmark setup):
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/panda
npm run uma:start:odrl:logged
```
This prints a timestamped log file and the exact export command for strict preflight:
```bash
export PANDA_UMA_ODRL_LOG_FILE="/absolute/path/to/panda/benchmark-results/uma-live-logs/uma-odrl-<timestamp>.log"
```

Manual equivalent (if needed):
1. Start UMA AS + CSS:
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/user-managed-access
corepack yarn start:odrl
```
2. In a second terminal, seed derived resources:
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/user-managed-access
corepack yarn run script:setup-alice-derived
```

## 2) Reset/seed commands
1. Seed source observation (ensures derived read resolves content):
```bash
curl -sS -X POST http://localhost:3000/alice/acc-x/ \
  -H "Content-Type: text/turtle" \
  -d '<http://example.org/obs-runbook> <https://saref.etsi.org/core/hasTimestamp> "2026-04-17T16:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .'
```
2. Optional strict matrix policy+enforcement seed/proof:
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/PANDA
./scripts/uma/benchmark_enforcement_matrix.sh
```

## 3) Benchmark preflight commands
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/PANDA
node scripts/uma/smoke.js
```

## 4) Expected success output
- `Challenge status=401`
- `Allow exchange status=200`
- `Allow fetch status=200`
- `Reuse fetch status=200`

## 5) Expected denial output
- `Wrong-target fetch status=403` (or `401`)
- `Deny exchange status=403`
- `Invalid-claim exchange status>=400` (currently `500` for malformed WebID in this stack)

## 6) Cold benchmark run
1. Fresh process start (`start:odrl` restarted).
2. Run benchmark with token reuse disabled:
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/PANDA
PANDA_UMA_REUSE_ACCESS_TOKEN=false WARMUP_ITERATIONS=0 ITERATIONS=20 node scripts/benchmark/uma_odrl_flow_benchmark.js
```

## 7) Warm benchmark run
1. Keep same processes running.
2. Run benchmark with reuse enabled:
```bash
cd /Users/kushbisen/Code/PANDA\ Platform/PANDA
PANDA_UMA_REUSE_ACCESS_TOKEN=true WARMUP_ITERATIONS=5 ITERATIONS=20 node scripts/benchmark/uma_odrl_flow_benchmark.js
```

## 8) Invalid benchmark conditions
- Initial request is not `401 UMA challenge`.
- `WWW-Authenticate` missing UMA ticket.
- Authorized exchange does not produce `200` for allowed identity.
- Deny identity does not produce `403`.
- Resource returns `200` without prior UMA challenge in benchmark mode.
- REPLAYER benchmark mode (`REPLAYER_UMA_BENCHMARK_MODE=true`) sees tokenless `200` (must hard fail).
- UMA logs do not show ODRL evaluation for both allow and deny checks.

## Warm-state reuse summary
- Token reuse: optional, controlled by `PANDA_UMA_REUSE_ACCESS_TOKEN`.
- Policy cache/store: reused in running UMA process.
- HTTP connection reuse: reused by Node/curl default keep-alive behavior.
- Parsed RDF/policy state: reused in in-memory process state and persisted policy backup.
