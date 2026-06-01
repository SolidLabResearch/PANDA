# PANDA Scenarios And Reproducibility

This document summarizes the scenario-level reproducibility view for PANDA: what the monitored scenario is, which branches implement or benchmark parts of it, which inputs and policies are involved, and which uncertainties still need confirmation from repository evidence.

For branch-by-branch implementation details, benchmark entry points, protected resources, and policy-category mappings, see [docs/BRANCHES_AND_POLICIES.md](BRANCHES_AND_POLICIES.md).

## Scope Note

Branch names and scenario names are not always one-to-one in this repository:

- one branch can contain multiple scenario JSON files or benchmark helpers
- one scenario name can be reused across branches with different instrumentation or completion conditions
- some branches are feature, migration, or tooling branches rather than standalone scenario branches

Use this document for the scenario-level overview, and use [docs/BRANCHES_AND_POLICIES.md](BRANCHES_AND_POLICIES.md) when the question is branch-specific.

### Resource Name Compatibility

Historically, the repository has used `/alice/spo2/` and `/alice/heart-ibi/` in older examples and run outputs. The canonical scenario naming now uses `/alice/heart/` for the protected source stream, with `heart-last-10-min` for the bounded derived window.

### UMA Dependency

PANDA scenarios are not expected to reproduce correctly against an arbitrary upstream UMA server. Use the forked UMA server at [argahsuknesib/user-managed-access](https://github.com/argahsuknesib/user-managed-access), because PANDA depends on UMA/CSS support for derived resources. If the exact compatible branch or commit is known in a branch-specific setup, pin it there; otherwise maintainers should add a TODO to pin the exact revision for archival reproducibility.

## Scenario: RSP-QL Heart / IBI Monitoring

### Purpose

The repository evidence supports a family of closely related PANDA evaluation scenarios built around live RSP-QL monitoring, derived-resource materialization, and UMA-protected reads. The shared pattern is:

- observations are posted to a Solid resource path
- PANDA registers a live query over that stream or a derived substream
- rules detect an alert or anomaly condition
- PANDA or a benchmark harness validates authorized and denied access paths

The exact scenario objective changes by branch:

- baseline live query registration
- limited caregiver access to a derived time window
- policy-based denial
- protected result or protected alert reads
- policy-size benchmarking
- concurrent authorization benchmarking
- CPU / memory measurement around the existing benchmark harness

See [docs/BRANCHES_AND_POLICIES.md](BRANCHES_AND_POLICIES.md) for the branch-by-branch breakdown.

### Related Branches

The following mappings are supported by repository evidence:

- `baseline-scenario`: baseline live query plus protected RSP-result anomaly flow
- `limited-access-caregiver-scenario`: bounded caregiver access to a derived 10-minute window
- `policy-based-denial`: unauthorized requester denial
- `protected-alert`: protected anomaly-flow instrumentation; branch name does not map cleanly to a standalone alert-only scenario
- `authorized-caregiver-alert-read-benchmark`: protected alert access and protected alert lifecycle benchmarks
- `policy-size-benchmark`: ODRL policy graph size benchmark
- `concurrent-requests`: concurrent cold UMA authorization benchmark
- `benchmark-cpu-memory`: resource-usage collection layered onto the benchmark harness

Related but not scenario-specific branches:

- `benchmark`: shared benchmark harness
- `feature/stabilize-uma-headless`: UMA smoke, preflight, and logged startup helpers
- `feature/audit-logged-query-service`: query audit logging and actor/scope-aware reuse
- `node-migration`: Node 22 migration plus historical benchmark artifacts
- `codex/e2e-replayer-panda-uma-flow`: E2E derived-resource UMA flow tooling

### Input Data

Confirmed repository evidence shows multiple input variants rather than a single canonical dataset:

- live stream transport paths such as `http://localhost:3000/alice/heart/`
- protected-result and protected-alert branches that use `/alice/heart/` for the canonical scenario naming, with older benchmark artifacts still carrying `/alice/spo2/` transport-path labels as historical evidence
- real-stream replay input `data/heart.nt` on protected anomaly branches
- generated limited-window dataset `benchmarks/generated/heart-rate-ibi-real-10min.nt` on `limited-access-caregiver-scenario`

See also [docs/data/DATASETS.md](data/DATASETS.md).

### RSP-QL Query

The repository does not contain a single confirmed canonical query for all branches. Confirmed examples include:

- `benchmarks/scenarios/00-live-window-query-baseline.json` on baseline-style branches:
  - live query over `http://localhost:3000/alice/heart/`
  - aggregate form such as `AVG(?o)`
- `benchmarks/scenarios/10-uma-replayer-panda-derived-anomaly-e2e.json` on protected branches:
  - live query over `http://localhost:3000/alice/heart/`
  - aggregate form such as `MAX(?o)` or branch-local variants
- `benchmarks/scenarios/03-limited-caregiver-time-window-processing.json` on `limited-access-caregiver-scenario`:
  - live query over `http://localhost:3000/alice/derived/heart-last-10-min/`
  - aggregate form `AVG(?o)`

Reference file for the general topic: [docs/queries/rspql/heart_ibi_window.rq](queries/rspql/heart_ibi_window.rq).

TODO:
- confirm whether [docs/queries/rspql/heart_ibi_window.rq](queries/rspql/heart_ibi_window.rq) is intended to represent the limited-window caregiver scenario, the baseline protected anomaly flow, or only an illustrative example

### Notation3 Rule

The repository again shows multiple rule variants rather than one canonical rule:

- baseline-style rule examples detect heart/IBI anomalies on the `/alice/heart/` transport path
- protected anomaly branches include heart/IBI-oriented thresholds such as `math:greaterThan 99.9`
- limited caregiver processing uses a rule that emits `HEART_RATE_ALERT`

Reference file for the general topic: [docs/rules/n3/anomaly_detection.n3](rules/n3/anomaly_detection.n3).

TODO:
- confirm whether [docs/rules/n3/anomaly_detection.n3](rules/n3/anomaly_detection.n3) is intended to represent one of the protected anomaly branches or only a generic anomaly-detection example

### UMA / ODRL Policy

No single policy document covers all branches. The evidence-based policy variants are:

- baseline allow pattern:
  - simple Bob read access to a derived resource such as `/alice/derived/acc-x/`
  - protected-result branches where Bob is the allowed nurse/caregiver reader
  - historical example policy: `https://github.com/argahsuknesib/user-managed-access/blob/benchmarking/packages/uma/config/rules/odrl/policy0.ttl` currently uses older `spo2` labels, but PANDA should document the equivalent policy structure with canonical heart/IBI naming: `/alice/heart/`, `/alice/derived/heart/`, `/alice/heart/derived`, and `heart-last-10-min`
  - canonical PANDA example policy file: [docs/policies/example-heart-policy.ttl](docs/policies/example-heart-policy.ttl)
  - this file is an example policy shape only; branch-specific policy behavior still takes precedence when documented
- limited caregiver pattern:
  - caregiver access is limited to `http://localhost:3000/alice/derived/heart-last-10-min/`
  - exact Turtle policy file is not tracked
- denial pattern:
  - unauthorized requester Jim is denied
  - explicit prohibition file was not confirmed
- protected alert pattern:
  - protected-alert branch introduces JWT-based claim defaults with WebID and ODRL purpose
  - authorized-caregiver-alert-read-benchmark adds alert-read benchmarks but has actor-naming inconsistencies
- policy-size pattern:
  - exactly one matching read policy plus distractor policies at sizes `1, 5, 10, 25, 50, 100`
- concurrent-requests pattern:
  - protected target must first challenge
  - optional purpose-enforcement matrix checks missing or wrong purpose
- setup assumption:
  - PANDA reproductions should use the forked UMA server at `https://github.com/argahsuknesib/user-managed-access`, not an arbitrary upstream/default UMA server
  - if no exact branch or commit is documented in setup files, preserve a TODO to pin the compatible UMA revision

For actor, target, action, and constraint details by branch, see [docs/BRANCHES_AND_POLICIES.md](BRANCHES_AND_POLICIES.md).

### Benchmark Commands

There is no single benchmark command for all branches. Confirmed branch-specific entry points include:

```bash
# Shared scenario harness
node scripts/benchmark/run_all_scenarios.js --mode smoke --runs 1 --warmup 0

# Live registration benchmark
npm run benchmark:live-registration -- --runs 30 --warmup 5

# UMA smoke / preflight
npm run smoke:uma
node scripts/uma/preflight-derived.js

# Protected alert benchmarks
npm run benchmark:protected-alert-access -- --runs 30 --warmup 5
npm run benchmark:protected-alert-lifecycle -- --runs 1 --warmup 0

# Policy-size benchmark
npm run benchmark:odrl-policy-graph-size:generate
npm run benchmark:odrl-policy-graph-size

# Concurrent authorization benchmark
node scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js --force
```

Use [docs/BRANCHES_AND_POLICIES.md](BRANCHES_AND_POLICIES.md) for the branch-specific command list and output locations.

### Expected Behavior

Authorized case:

- the protected target should not be public before authorization
- the requester should receive a UMA challenge with a ticket
- token exchange should succeed for the allowed identity
- the authorized GET should return `200`
- scenario-specific outputs such as websocket results, protected result materialization, or alert reads should satisfy the branch validator

Denied case:

- unauthorized identities should fail token exchange or the authorized retry
- wrong-target access should return `401` or `403`
- branches that model denial should not silently succeed because of actor mismatch or stale public resources

### Expected Output

Expected artifacts depend on the branch:

- `benchmarks/results/runs/<benchmark-id>/` for the shared scenario harness
- `benchmark-results/protected-alert-access-<run-id>/` for direct alert-access measurements
- `benchmark-results/protected-alert-lifecycle-<run-id>/` for lifecycle measurements
- `benchmarks/generated/odrl-policy-graph-size/` for generated policy sets
- `benchmark-results/uma-*` on `node-migration` for historical proof and latency artifacts

See [docs/BRANCHES_AND_POLICIES.md](BRANCHES_AND_POLICIES.md) for output-path details and warnings about stale result folders.

## Explicit Documentation Inconsistencies

The following inconsistencies are known and should be preserved as documentation notes unless the code or branch contents are changed:

### Branch Name vs Scenario Name

- `protected-alert` is the branch name, but the tracked scenario JSON is still centered on a protected RSP-result anomaly flow rather than a standalone alert-only scenario.

### Actor Naming Mismatch

- `authorized-caregiver-alert-read-benchmark` mixes Bob/caregiver defaults in direct alert-read benchmark code with an Alice-based `latest-anomaly` completion condition in its branch-local scenario JSON.

### Transport Path vs Payload Semantics

- Older benchmark artifacts and some historical run outputs still use `/alice/spo2/` as the transport path.
- Those labels are preserved as historical evidence and should not be read as the canonical scenario name.

### Historical Benchmark Outputs

- `node-migration` contains committed benchmark outputs such as `benchmark-results/uma-*`.
- These are historical artifacts and must be rerun before citation; their presence in the repository is not enough to treat them as current benchmark evidence.