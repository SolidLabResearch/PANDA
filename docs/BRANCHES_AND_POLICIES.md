# PANDA Branches And Policies

## Purpose

This document maps PANDA branches to the scenarios, protected resources, UMA/ODRL assumptions, benchmark harnesses, and support tooling that are actually implemented in the repository. It is intentionally evidence-based:

- branch claims are grounded in `git diff main...<branch>`, tracked files, and branch-local scripts/docs
- protected resources and expected behavior are taken from scenario JSON, benchmark scripts, and UMA smoke/preflight tooling
- anything that could not be confirmed from repository content is marked `TODO` with a short reason

PANDA reproductions are expected to use the forked UMA server at [argahsuknesib/user-managed-access](https://github.com/argahsuknesib/user-managed-access), not an arbitrary upstream/default UMA server. The reason is practical, not semantic: PANDA needs UMA/CSS support for derived resources in the branch/local setup used by the documented scenarios.

`docs/SCENARIOS_AND_REPRODUCIBILITY.md` provides the scenario-level reproducibility view. This document is the branch-level companion that records the concrete branch diffs, protected resources, benchmark entry points, and policy assumptions behind those scenarios.

## Branch Overview

| Branch | Branch type | Implemented scenario or purpose | Protected resource / stream / endpoint | Required policy setup | Benchmark or validation role | Evidence files | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `main` | Base | Core PANDA application and placeholder docs only | No branch-local benchmark scenario files | No branch-local benchmark policy harness on `main` | Base for all diffs | `package.json`, `README.md`, absence of `scripts/benchmark/` and `benchmarks/scenarios/` on `main` | Implemented base, no scenario map on branch |
| `baseline-scenario` | Scenario + benchmark | Baseline live query and protected RSP-result anomaly flow | `http://localhost:3000/alice/heart/`, `.../alice/derived/latest`, `.../alice/derived/anomaly-alert/`, `.../alice/protected-rsp-results/` | Allow policy for Alice/Bob protected-result read; branch docs also show derived `acc-x` allow policy examples | Baseline scenario validation and shared benchmark harness | `benchmarks/scenarios/00-live-window-query-baseline.json`, `benchmarks/scenarios/10-uma-replayer-panda-derived-anomaly-e2e.json`, `scripts/benchmark/run_all_scenarios.js` | Implemented |
| `limited-access-caregiver-scenario` | Scenario + benchmark | Caregiver can access only a fixed 10-minute derived time window and process it | `http://localhost:3000/alice/derived/heart-last-10-min/`, filter `http://localhost:3000/alice/filters/heart-last-10-min.rq`, source `.../alice/heart/` | Meta files on `alice`, `alice/heart`, `alice/derived`, `alice/filters`; branch does not contain an explicit Turtle policy artifact for this scenario | Scenario-specific validation of bounded-view access and processing | `benchmarks/scenarios/02-limited-caregiver-time-window-access.json`, `benchmarks/scenarios/03-limited-caregiver-time-window-processing.json`, `benchmarks/generated/heart-rate-ibi-real-10min.nt` | Implemented, policy text partly implicit |
| `policy-based-denial` | Scenario + benchmark | Unauthorized requester denial for live query registration against protected resources | `http://localhost:3000/alice/heart/`, `.../alice/derived/latest`, `.../alice/derived/anomaly-alert/` | Denial is driven by requester mismatch: scenario actor is Jim, while allow-path examples in branch docs/scripts use Bob | Denial-path validation | `benchmarks/scenarios/01-policy-based-denial.json`, `scripts/uma/smoke.js`, `scripts/uma/benchmark_enforcement_matrix.sh` | Implemented |
| `protected-alert` | Scenario + benchmark | Protected alert / protected-result lifecycle instrumentation on top of protected anomaly flow | Same endpoints as baseline protected anomaly flow | JWT UMA claim format with WebID plus ODRL purpose by default in `src/config/UmaClaim.ts` | Adds protected lifecycle metrics and stricter claim handling | `src/config/UmaClaim.ts`, `scripts/benchmark/run_all_scenarios.js`, `benchmarks/scenarios/10-uma-replayer-panda-derived-anomaly-e2e.json` | Implemented |
| `authorized-caregiver-alert-read-benchmark` | Benchmark | Direct benchmark for protected alert access and full protected alert lifecycle | `http://localhost:3000/alice/derived/anomaly-alert/`; scenario file also uses `.../alice/derived/latest-anomaly` | Managed preflight requires derived setup and anomaly-alert smoke; access benchmark defaults to Bob WebID claim | Measures alert read latency and end-to-end alert lifecycle | `scripts/benchmark/protected_alert_access_benchmark.js`, `scripts/benchmark/protected_alert_lifecycle_benchmark.js`, `package.json` | Implemented |
| `policy-size-benchmark` | Benchmark | Measures effect of ODRL policy graph size on authorization | Default target `http://localhost:3000/alice/heart/` | Generated ODRL policy sets with exactly one matching read permission and distractor policies | Policy-size benchmark generation, execution, and validation | `scripts/benchmark/odrl_policy_graph_size_shared.js`, `scripts/benchmark/generate_odrl_policy_graph_size_sets.js`, `scripts/benchmark/run_odrl_policy_graph_size_benchmark.js` | Implemented |
| `concurrent-requests` | Benchmark | Cold concurrent UMA authorization pressure | Default target `http://localhost:3000/alice/heart/`; default token endpoint `http://localhost:4000/uma/token` | Protected target must challenge first; raw WebID claim tokens are expected by default; optional purpose-matrix script uses JWT purpose claims against `.../alice/derived/latest` | Concurrent authorization benchmark, plus purpose-enforcement probe | `scripts/benchmark/run_concurrent_cold_uma_authorization.js`, `scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js`, `scripts/uma/purpose_enforcement_matrix.js` | Implemented |
| `benchmark-cpu-memory` | Benchmark/tooling | Resource-usage sampling for scenario runs | Same scenario targets as shared benchmark harness | No new policy model; samples PANDA/UMA/CSS process usage during existing benchmark runs | CPU/RSS/heap collection, aggregation, and validation | `scripts/benchmark/test_resource_sampler.js`, `scripts/benchmark/run_all_scenarios.js`, `scripts/benchmark/aggregate_results.js` | Implemented |
| `benchmark` | Benchmark/tooling | Shared benchmark harness without branch-specific scenario additions beyond baseline live-window JSON | `http://localhost:3000/alice/heart/`, `.../alice/derived/latest`, `.../alice/derived/anomaly-alert/` | Shared UMA smoke/preflight and ODRL benchmark helpers | Base benchmark branch for later benchmark branches | `scripts/benchmark/README.md`, `scripts/benchmark/benchmark_live_registration.js`, `benchmarks/scenarios/00-live-window-query-baseline.json` | Implemented |
| `feature/stabilize-uma-headless` | Feature/tooling | Headless UMA stabilization, preflight, and logged startup helpers | Default smoke target `http://localhost:3000/alice/derived/acc-x/`; wrong-target `.../alice/derived/acc-y/` | Simple allow policy bootstrap for Bob on `acc-x`, plus deny/wrong-target checks | Environment stabilization for later benchmark branches | `scripts/uma/smoke.js`, `scripts/uma/preflight-derived.js`, `scripts/uma/start_odrl_logged.sh` | Implemented |
| `feature/audit-logged-query-service` | Feature | Query registration reuse and access audit logging | Query audit log file `query_audit_log.json`; PANDA query registration paths | No new policy files, but query reuse is now scoped by actor and authorization scope | Functional feature used by later benchmark branches | `src/service/query-registry/AuditLoggedQueryService.ts`, `src/service/query-registry/AuditLoggedQueryService.test.ts`, `src/server/QueryHandler.ts` | Implemented |
| `node-migration` | Migration + benchmark groundwork | Node 22 migration, UMA benchmark runbook, and recorded sample benchmark outputs | Default runbook target `http://localhost:3000/alice/derived/acc-x/` | Simple allow / deny / wrong-target proof through smoke and enforcement matrix scripts | Migration branch with tracked result artifacts | `package.json`, `Dockerfile`, `documents/UMA_BENCHMARK_RUNBOOK.md`, `benchmark-results/uma-proof-20260417-162009/` | Implemented, results are historical artifacts |
| `codex/e2e-replayer-panda-uma-flow` | Tooling / E2E | E2E replay + PANDA + UMA validation helpers for derived resource flow | `http://localhost:3000/alice/derived/acc-x/` | Manual or scripted ODRL allow policy for Bob on derived `acc-x` | Repro and debug tooling for the derived-resource UMA flow | `documents/LIVE_TEST_INSTRUCTIONS.md`, `scripts/uma/LIVE_TEST_DERIVED_RESOURCE.sh`, `scripts/uma/smoke.js` | Implemented as tooling, not a dedicated benchmark scenario branch |

## Policy Categories

### Baseline allow policy

- Branches using it: `baseline-scenario`, `benchmark`, `feature/stabilize-uma-headless`, `node-migration`, `codex/e2e-replayer-panda-uma-flow`
- Purpose: prove the standard UMA challenge -> token exchange -> authorized GET path works for an explicitly allowed requester
- Example ODRL policy: an equivalent historical policy is available in the compatible UMA server repository at `https://github.com/argahsuknesib/user-managed-access/blob/benchmarking/packages/uma/config/rules/odrl/policy0.ttl`. The linked file currently uses older `spo2` labels, but PANDA documentation should describe the equivalent policy structure with canonical heart/IBI naming: `/alice/heart/`, `/alice/derived/heart/`, `/alice/heart/derived`, and `heart-last-10-min`.
- Canonical PANDA example policy file: [docs/policies/example-heart-policy.ttl](docs/policies/example-heart-policy.ttl). Treat this as the documentation/example policy shape; branch-specific policy behavior still takes precedence when documented.
- Equivalent PANDA heart/IBI policy shape:
  - Alice owner permissions cover the protected source stream, derived-resource container, and notification channel ownership.
  - Bob / benchmark-client permissions cover the allowed read path for protected result access and benchmark validation.
  - PANDA permissions cover protected scenario execution against the canonical heart/IBI resources.
  - Replayer permissions cover publishing the source stream input that drives the live scenario or benchmark.
  - Source container access applies to `http://localhost:3000/alice/heart/`.
  - Derived-resource container access applies to `http://localhost:3000/alice/derived/heart/` and `http://localhost:3000/alice/derived/`.
  - Latest derived result read access applies to `http://localhost:3000/alice/derived/latest`.
  - Webhook channel access applies to `http://localhost:3000/.notifications/WebhookChannel2023/`.
  - `urn:client:benchmark` purpose constraints apply to benchmark actors that are allowed to read the protected result path.
  - Canonical resource names are `http://localhost:3000/alice/heart/`, `http://localhost:3000/alice/derived/heart/`, `http://localhost:3000/alice/heart/derived`, `http://localhost:3000/alice/derived/latest`, `http://localhost:3000/alice/derived/`, and `http://localhost:3000/.notifications/WebhookChannel2023/`.
  - The linked external policy currently uses historical `spo2` labels, and those labels should not be copied into new PANDA-facing documentation.
- Assignee / actor: Bob in the derived-resource examples (`http://localhost:3000/bob/profile/card#me`); protected-result benchmark scenarios also use Bob as the nurse/caregiver reader
- Target resource: derived resource `http://localhost:3000/alice/derived/acc-x/` in the UMA smoke/live-test docs; protected-result scenario uses `http://localhost:3000/alice/protected-rsp-results/{benchmark_run_id}.ttl`
- Action: `odrl:read`
- Purpose constraint: none in the simple `acc-x` examples
- Source/data constraint: none confirmed in the simple `acc-x` examples
- Other constraints: assigner is Alice in the manual policy examples
- Authorized behavior: initial GET returns UMA challenge; token exchange succeeds; authorized GET returns `200`
- Denied behavior: wrong target and deny-claim path are expected to return `401` or `403`
- Relevant files:
  - [docs/policies/example-heart-policy.ttl](docs/policies/example-heart-policy.ttl)
  - `documents/LIVE_TEST_INSTRUCTIONS.md` on `node-migration` and `codex/e2e-replayer-panda-uma-flow`
  - `scripts/uma/smoke.js` on `feature/stabilize-uma-headless`
  - `benchmarks/scenarios/10-uma-replayer-panda-derived-anomaly-e2e.json` on `baseline-scenario`
- TODO: the repository does not contain a single canonical Turtle file for the baseline protected-result policy; the evidence is split across benchmark JSON, smoke helpers, and docs

### Limited caregiver access policy

- Branches using it: `limited-access-caregiver-scenario`
- Purpose: allow a caregiver to read and process only a derived 10-minute window instead of the full legacy source container
- Assignee / actor: `http://localhost:3000/caregiver/profile/card#me`
- Target resource: `http://localhost:3000/alice/derived/heart-last-10-min/`
- Action: read / live query registration against the derived window
- Purpose constraint: not explicitly encoded in a tracked Turtle policy file
- Source/data constraint: fixed time window from `2026-05-13T09:04:47.027000Z` to `2026-05-13T09:14:47.027Z`
- Other constraints: filter resource `http://localhost:3000/alice/filters/heart-last-10-min.rq`; expected event rate `1 Hz`; expected in-window observation count `521` for processing scenario
- Authorized behavior: caregiver reads the derived window and PANDA can register a live query against that derived stream
- Denied behavior: source container access is described as denied in the scenario description, but the exact deny script/assertion is not tracked separately
- Relevant files:
  - `benchmarks/scenarios/02-limited-caregiver-time-window-access.json`
  - `benchmarks/scenarios/03-limited-caregiver-time-window-processing.json`
  - `benchmarks/generated/heart-rate-ibi-real-10min.nt`
- TODO: no scenario-specific ODRL Turtle policy file is tracked, so assignee/target are confirmed but the exact ODRL serialization is not

### Policy-based denial policy

- Branches using it: `policy-based-denial`
- Purpose: verify protected resources reject an unauthorized requester
- Assignee / actor: denial scenario actor is Jim, `http://localhost:3000/jim/profile/card#me`
- Target resource: source stream `http://localhost:3000/alice/heart/`, derived latest `http://localhost:3000/alice/derived/latest`, alert container `http://localhost:3000/alice/derived/anomaly-alert/`
- Action: live query registration / protected read attempt
- Purpose constraint: none confirmed in the scenario JSON
- Source/data constraint: none confirmed
- Other constraints: denial is evidence-based through actor mismatch relative to Bob-oriented allow examples
- Authorized behavior: none for Jim in the denial scenario
- Denied behavior: `expected_decision` is `deny`; smoke matrix scripts also expect `403` for deny claims
- Relevant files:
  - `benchmarks/scenarios/01-policy-based-denial.json`
  - `scripts/uma/smoke.js`
  - `scripts/uma/benchmark_enforcement_matrix.sh`
- TODO: the branch does not include a Jim-specific prohibition Turtle file; denial is inferred from mismatched requester identity and enforcement scripts

### Protected alert policy

- Branches using it: `protected-alert`, `authorized-caregiver-alert-read-benchmark`
- Purpose: protect alert outputs and measure the read path after alert materialization
- Assignee / actor:
  - Bob on direct alert access benchmark defaults (`PANDA_UMA_CLAIM_TOKEN` fallback)
  - Alice on the branch-local `10-uma-replayer-panda-derived-anomaly-e2e.json` in `authorized-caregiver-alert-read-benchmark`, where completion is `alice_latest_anomaly_uma_read`
- Target resource:
  - `http://localhost:3000/alice/derived/anomaly-alert/`
  - `http://localhost:3000/alice/derived/latest-anomaly`
- Action: `odrl:read`
- Purpose constraint: `protected-alert` switches default UMA claims to JWT with ODRL purpose `urn:client:benchmark`
- Source/data constraint: alert must come from current-run replay data; lifecycle benchmark explicitly checks current-run freshness
- Other constraints: branch-local lifecycle benchmark requires derived setup verification and anomaly-alert smoke before measurement
- Authorized behavior: unauthenticated GET must challenge; authorized GET after ticket exchange must return `200`
- Denied behavior: public `200` on unauthenticated GET is treated as benchmark failure
- Relevant files:
  - `src/config/UmaClaim.ts` on `protected-alert`
  - `scripts/benchmark/protected_alert_access_benchmark.js`
  - `scripts/benchmark/protected_alert_lifecycle_benchmark.js`
  - `benchmarks/scenarios/10-uma-replayer-panda-derived-anomaly-e2e.json` on `authorized-caregiver-alert-read-benchmark`
- TODO: actor naming is inconsistent across branches: some files say Bob/nurse/caregiver, while the later scenario JSON says Alice reads `latest-anomaly`

### Policy-size / complexity policies

- Branches using it: `policy-size-benchmark`
- Purpose: measure authorization cost as the ODRL graph grows
- Assignee / actor: default requester `http://localhost:3000/bob/profile/card#me`
- Target resource: default target `http://localhost:3000/alice/heart/`
- Action: `read`
- Purpose constraint: none in the generated graph-size benchmark
- Source/data constraint: none
- Other constraints:
  - exactly one matching read policy is generated
  - distractor policies vary by target mismatch, assignee mismatch, patient mismatch, derived-resource mismatch, and optionally non-read action mismatch
  - tracked benchmark policy counts are `1, 5, 10, 25, 50, 100`
- Authorized behavior: the one matching policy should authorize the request
- Denied behavior: distractor policies must not match
- Relevant files:
  - `scripts/benchmark/odrl_policy_graph_size_shared.js`
  - `scripts/benchmark/generate_odrl_policy_graph_size_sets.js`
  - `benchmarks/generated/odrl-policy-graph-size/manifest.json` on `authorized-caregiver-alert-read-benchmark`
- TODO: the actual `policy-size-benchmark` branch does not track benchmark result folders in the inspected diff, only generation and execution tooling

### Concurrent request policy

- Branches using it: `concurrent-requests`
- Purpose: measure cold concurrent authorization pressure, not PANDA stream throughput
- Assignee / actor: default raw WebID claim tokens or token list passed at runtime; service wrapper defaults to Bob as the authorized WebID
- Target resource: default `http://localhost:3000/alice/heart/`
- Action: protected GET with fresh token exchange for each client
- Purpose constraint:
  - none in the main concurrent benchmark
  - explicit purpose constraint is tested separately by `scripts/uma/purpose_enforcement_matrix.js`
- Source/data constraint: none
- Other constraints:
  - no RPT reuse
  - concurrency levels default to `1,2,5,10,20`
  - bursts default to `30`
  - clients are released from an in-process barrier and start skew is recorded
- Authorized behavior: preflight requires protected challenge, then token exchange and authorized GET succeed for authorized identities
- Denied behavior: purpose-enforcement matrix expects missing or wrong purpose to fail, and non-authorized identities to fail
- Relevant files:
  - `scripts/benchmark/run_concurrent_cold_uma_authorization.js`
  - `scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js`
  - `scripts/uma/purpose_enforcement_matrix.js`

### CPU / memory benchmark policy assumptions

- Branches using it: `benchmark-cpu-memory`
- Purpose: attach resource usage metrics to existing scenario runs
- Assignee / actor: inherited from the scenarios being sampled
- Target resource: inherited from `benchmarks/scenarios/00-live-window-query-baseline.json` and any scenario executed by `run_all_scenarios.js`
- Action: no new authorization action; the branch adds sampling only
- Purpose constraint: no new policy constraint
- Source/data constraint: no new data constraint
- Other constraints: Linux `/proc` sampling only; default sample interval `500 ms`
- Authorized behavior: same as underlying scenario
- Denied behavior: same as underlying scenario
- Relevant files:
  - `scripts/benchmark/run_all_scenarios.js`
  - `scripts/benchmark/aggregate_results.js`
  - `scripts/benchmark/test_resource_sampler.js`

### UMA headless / audit logging / E2E replay policy assumptions

- Branches using it: `feature/stabilize-uma-headless`, `feature/audit-logged-query-service`, `codex/e2e-replayer-panda-uma-flow`
- Purpose:
  - headless branch: make UMA challenge and derived-resource checks reliable in automated runs
  - audit branch: preserve actor/scope-aware query reuse and audit access
  - E2E branch: provide exact commands for reproducing the derived-resource flow
- Assignee / actor: Bob in the derived-resource smoke and live-test docs
- Target resource: `http://localhost:3000/alice/derived/acc-x/`
- Action: `read`
- Purpose constraint: none in the E2E/live-test docs; the audit branch is policy-adjacent rather than policy-defining
- Source/data constraint: none confirmed
- Other constraints:
  - headless smoke bootstraps a simple allow policy and checks wrong-target + deny-claim paths
  - audit branch reuses queries only when normalized query, actor, and authorization scope match; live queries always execute fresh
- Authorized behavior: final derived-resource GET returns `200`
- Denied behavior: wrong target and deny identity are expected to fail
- Relevant files:
  - `scripts/uma/smoke.js`
  - `scripts/uma/preflight-derived.js`
  - `src/service/query-registry/AuditLoggedQueryService.ts`
  - `documents/LIVE_TEST_INSTRUCTIONS.md` on `codex/e2e-replayer-panda-uma-flow`

## Branch Details

### `main`

- Purpose: stable base application branch
- Scenario: none encoded as a branch-local benchmark scenario
- What changed compared with `main`: not applicable
- Protected resource or stream: no dedicated benchmark scenario files on this branch
- Required UMA/ODRL policy: not documented on `main`
- Expected authorized behavior: core PANDA behavior only
- Expected denied behavior: core PANDA behavior only
- Benchmark/evaluation relevance: this is the diff base for all inspected branches
- Commands to run or validate the branch:
  - `npm test`
  - `npm run lint:ts`
- Result files or output artifacts: none tracked under `benchmarks/scenarios/` or `scripts/benchmark/`
- Known limitations or TODOs:
  - `README.md` points to scenario/policy docs, but `main` itself does not contain the benchmark harness used by the inspected scenario branches

### `baseline-scenario`

- Purpose: establish the shared baseline benchmark harness plus two scenario definitions
- Scenario:
  - `00-live-window-query-baseline.json` for live query registration against `alice/heart`
  - `10-uma-replayer-panda-derived-anomaly-e2e.json` for protected RSP-result anomaly flow
- What changed compared with `main`:
  - adds `scripts/benchmark/`
  - adds `benchmarks/scenarios/`
  - adds `scripts/uma/` smoke/preflight helpers
  - adds embedded `replayer/` and `oidc-provider/`
  - upgrades runtime in `package.json` and `Dockerfile`
- Protected resource or stream:
  - `http://localhost:3000/alice/heart/`
  - `http://localhost:3000/alice/derived/latest`
  - `http://localhost:3000/alice/derived/anomaly-alert/`
  - `http://localhost:3000/alice/protected-rsp-results/`
- Required UMA/ODRL policy:
  - protected-result scenario identifies Alice as owner and Bob as nurse reader
  - branch docs and smoke helpers show the simple allow pattern for derived resources
- Expected authorized behavior:
  - live query baseline returns websocket results with `query_hash`, `aggregation_event`, and `benchmark_timing`
  - protected scenario writes the protected result and completes only after nurse notification plus UMA-authorized GET
- Expected denied behavior:
  - wrong-target / deny-claim smoke path should fail
- Benchmark/evaluation relevance: reference branch for later protected, concurrent, and alert branches
- Commands to run or validate the branch:
  - `npm run benchmark:live-registration -- --runs 30 --warmup 5`
  - `npm run benchmark:uma-odrl`
  - `npm run smoke:uma`
  - `node scripts/benchmark/run_all_scenarios.js --mode smoke --runs 3 --warmup 0`
- Result files or output artifacts, if present:
  - benchmark harness writes to `benchmarks/results/runs/<benchmark-id>/`
- Known limitations or TODOs:
  - branch docs contain both `heart` transport paths and heart/IBI semantics; this is intentional per `scripts/benchmark/README.md` but easy to misread

### `limited-access-caregiver-scenario`

- Purpose: implement a bounded caregiver view over a derived 10-minute window
- Scenario:
  - access scenario `02-limited-caregiver-time-window-access.json`
  - processing scenario `03-limited-caregiver-time-window-processing.json`
- What changed compared with `main`:
  - inherits the shared benchmark/tooling stack
  - adds scenario JSON for caregiver-limited access
  - adds generated dataset `benchmarks/generated/heart-rate-ibi-real-10min.nt`
- Protected resource or stream:
  - source `http://localhost:3000/alice/heart/`
  - derived window `http://localhost:3000/alice/derived/heart-last-10-min/`
  - filter `http://localhost:3000/alice/filters/heart-last-10-min.rq`
- Required UMA/ODRL policy:
  - caregiver actor is `http://localhost:3000/caregiver/profile/card#me`
  - access is limited to the derived time-window view
  - branch evidence is in scenario JSON and filter/meta paths, not a tracked policy Turtle file
- Expected authorized behavior:
  - caregiver can read the derived 10-minute window
  - PANDA can run a live query on that derived stream and expect `521` in-window observations with anomaly expected
- Expected denied behavior:
  - direct access to the legacy source container is described as denied
- Benchmark/evaluation relevance: scenario-specific evaluation of least-privilege caregiver access
- Commands to run or validate the branch:
  - `node scripts/benchmark/run_all_scenarios.js --mode smoke --runs 1 --warmup 0`
  - No dedicated `package.json` script names were added specifically for these two scenario IDs; use the shared scenario harness directly
- Result files or output artifacts, if present:
  - `replayer/replayer-log.csv`
  - `benchmarks/results/runs/<benchmark-id>/` from the shared harness
- Known limitations or TODOs:
  - exact ODRL document for the limited caregiver policy is not tracked on the branch

### `policy-based-denial`

- Purpose: validate that unauthorized actors are denied
- Scenario: `01-policy-based-denial.json`
- What changed compared with `main`:
  - inherits the benchmark/tooling stack
  - adds denial scenario JSON
  - adds `src/config/UmaClaim.test.ts`
- Protected resource or stream:
  - `http://localhost:3000/alice/heart/`
  - `http://localhost:3000/alice/derived/latest`
  - `http://localhost:3000/alice/derived/anomaly-alert/`
- Required UMA/ODRL policy:
  - scenario actor is Jim
  - branch evidence supports denial by identity mismatch rather than by a tracked explicit prohibition file
- Expected authorized behavior: none for Jim in this scenario
- Expected denied behavior:
  - `expected_decision` is `deny`
  - no required log markers are defined, so the outcome is decision-based rather than marker-based
- Benchmark/evaluation relevance: negative-control scenario for the authorization path
- Commands to run or validate the branch:
  - `node scripts/benchmark/run_all_scenarios.js --mode smoke --runs 1 --warmup 0 --only-scenario policy-based-denial`
  - `npm run smoke:uma`
- Result files or output artifacts, if present:
  - shared benchmark outputs under `benchmarks/results/runs/<benchmark-id>/`
- Known limitations or TODOs:
  - no branch-local explicit `odrl:Prohibition` artifact was found

### `protected-alert`

- Purpose: extend the protected anomaly flow with explicit lifecycle timing and JWT-based claim defaults
- Scenario: same `10-uma-replayer-panda-derived-anomaly-e2e.json` name as `baseline-scenario`
- What changed compared with `main`:
  - inherits the larger benchmark/replayer stack
  - compared with `baseline-scenario`, adds lifecycle metrics in `run_all_scenarios.js`
  - changes UMA claims to signed JWTs with WebID and default ODRL purpose
- Protected resource or stream:
  - `http://localhost:3000/alice/protected-rsp-results/`
  - `http://localhost:3000/alice/derived/anomaly-alert/`
- Required UMA/ODRL policy:
  - default claim format becomes `urn:solidlab:uma:claims:formats:jwt`
  - default purpose becomes `urn:client:benchmark`
  - claim payload includes WebID and, unless disabled, ODRL purpose
- Expected authorized behavior:
  - protected lifecycle metrics such as `query_register_to_rule_match_ms`, `alert_materialization_ms`, and `notification_to_nurse_read_complete_ms` are populated
- Expected denied behavior:
  - the protected flow validation requires non-public protected results and positive lifecycle metrics
- Benchmark/evaluation relevance: turns the baseline protected anomaly flow into a more instrumented protected-alert branch
- Commands to run or validate the branch:
  - `node scripts/benchmark/run_all_scenarios.js --mode smoke --runs 1 --warmup 0 --only-scenario uma-replayer-panda-derived-anomaly-e2e`
  - `npm run smoke:uma`
- Result files or output artifacts, if present:
  - shared benchmark outputs under `benchmarks/results/runs/<benchmark-id>/`
- Known limitations or TODOs:
  - branch name says `protected-alert`, but the tracked scenario JSON is still centered on protected RSP results rather than a standalone alert-read benchmark

### `authorized-caregiver-alert-read-benchmark`

- Purpose: benchmark direct protected alert reads and full protected alert lifecycle
- Scenario:
  - direct alert access benchmark scripts
  - full lifecycle benchmark script
  - branch-local `10-uma-replayer-panda-derived-anomaly-e2e.json` that switches completion to Alice reading `latest-anomaly`
- What changed compared with `main`:
  - adds protected alert benchmark scripts and validators
  - adds package scripts:
    - `benchmark:protected-alert-access`
    - `benchmark:protected-alert-access:validate`
    - `benchmark:protected-alert-lifecycle`
    - `benchmark:protected-alert-lifecycle:validate`
- Protected resource or stream:
  - `http://localhost:3000/alice/derived/anomaly-alert/`
  - `http://localhost:3000/alice/derived/latest-anomaly`
  - source stream remains `http://localhost:3000/alice/heart/`
- Required UMA/ODRL policy:
  - access benchmark defaults to Bob WebID claim
  - lifecycle benchmark requires derived setup verification and protected alert generation
- Expected authorized behavior:
  - unauthenticated alert GET must not be public
  - token exchange must succeed
  - authorized alert GET must return `200`
  - lifecycle run must prove current-run alert freshness
- Expected denied behavior:
  - public alert resource is treated as failure
  - missing UMA challenge/token exchange is treated as failure
- Benchmark/evaluation relevance: this is the dedicated alert benchmark branch in the inspected set
- Commands to run or validate the branch:
  - `npm run benchmark:protected-alert-access -- --runs 30 --warmup 5`
  - `npm run benchmark:protected-alert-access:validate`
  - `npm run benchmark:protected-alert-lifecycle -- --runs 1 --warmup 0`
  - `npm run benchmark:protected-alert-lifecycle:validate`
- Result files or output artifacts, if present:
  - `benchmark-results/protected-alert-access-<run-id>/`
  - `benchmark-results/protected-alert-lifecycle-<timestamp>/`
- Known limitations or TODOs:
  - actor identity is inconsistent across files: some code measures Bob/caregiver alert reads, while the branch-local scenario JSON says Alice reads `latest-anomaly`

### `policy-size-benchmark`

- Purpose: measure how larger ODRL graphs affect authorization latency
- Scenario: generated graph-size policy sets, not a separate data-stream scenario
- What changed compared with `main`:
  - adds generator, runner, and validator for graph-size benchmarks
  - adds package scripts:
    - `benchmark:odrl-policy-graph-size:generate`
    - `benchmark:odrl-policy-graph-size`
    - `benchmark:odrl-policy-graph-size:validate`
- Protected resource or stream: default `http://localhost:3000/alice/heart/`
- Required UMA/ODRL policy:
  - exactly one matching read policy for Bob on Alice’s `heart` target
  - distractors cover target mismatch, assignee mismatch, patient mismatch, derived-resource mismatch, and optional action mismatch
- Expected authorized behavior:
  - generated matching policy count must be `1`
  - authorized GET on the target must eventually return `200`
- Expected denied behavior:
  - distractor policies must not authorize the request
- Benchmark/evaluation relevance: isolates policy graph size as the independent variable
- Commands to run or validate the branch:
  - `npm run benchmark:odrl-policy-graph-size:generate`
  - `npm run benchmark:odrl-policy-graph-size`
  - `npm run benchmark:odrl-policy-graph-size:validate`
- Result files or output artifacts, if present:
  - generated policies under `benchmarks/generated/odrl-policy-graph-size/`
  - run outputs written by the benchmark runner to its configured output directory
- Known limitations or TODOs:
  - no committed result folder was visible in the inspected branch diff

### `concurrent-requests`

- Purpose: benchmark concurrent cold UMA authorization
- Scenario: concurrent protected GETs released together from a barrier; not a PANDA throughput benchmark
- What changed compared with `main`:
  - adds concurrent benchmark runners
  - adds purpose-enforcement matrix script
  - updates UMA claim handling/tests
- Protected resource or stream:
  - default target `http://localhost:3000/alice/heart/`
  - purpose matrix default target `http://localhost:3000/alice/derived/latest`
  - UMA token endpoint `http://localhost:4000/uma/token`
- Required UMA/ODRL policy:
  - target must be protected and must not return `200` on tokenless GET
  - raw WebID claim tokens are expected by default in the concurrent benchmark
  - JWT WebID + purpose claims are used by the purpose matrix helper
- Expected authorized behavior:
  - authorized identities should obtain tokens and complete GETs
  - summary files should be written under aggregated results
- Expected denied behavior:
  - missing/wrong purpose or unauthorized identity should fail in the purpose matrix
- Benchmark/evaluation relevance: concurrency stress on authorization path
- Commands to run or validate the branch:
  - `node scripts/benchmark/run_concurrent_cold_uma_authorization.js --target-url http://localhost:3000/alice/heart/ --uma-token-endpoint http://localhost:4000/uma/token --claim-token <webid> --concurrency-levels 1,2,5,10,20 --bursts 30`
  - `node scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js --force`
  - `node scripts/uma/purpose_enforcement_matrix.js`
- Result files or output artifacts, if present:
  - aggregated summary files such as `concurrent-cold-uma-summary.json` and `.md` under `benchmarks/results/runs/<benchmark-id>/aggregated/`
- Known limitations or TODOs:
  - this branch measures authorization pressure only; it should not be cited as PANDA stream-processing throughput evidence

### `benchmark-cpu-memory`

- Purpose: collect CPU, RSS, and heap metrics during scenario runs
- Scenario: same scenario harness as `benchmark`, with optional resource sampling enabled
- What changed compared with `main`:
  - adds Linux `/proc`-based sampler support into `run_all_scenarios.js`
  - adds sampler test and resource aggregation logic
- Protected resource or stream: inherited from executed scenarios
- Required UMA/ODRL policy: inherited from executed scenarios
- Expected authorized behavior: same as executed scenario; resource sample files should also be written when enabled
- Expected denied behavior: same as executed scenario
- Benchmark/evaluation relevance: adds resource metrics to scenario results
- Commands to run or validate the branch:
  - `node scripts/benchmark/run_all_scenarios.js --mode smoke --runs 3 --warmup 0 --collect-resource-usage --resource-sample-interval-ms 500`
  - `node scripts/benchmark/aggregate_results.js --benchmark-id <benchmark-id>`
  - `node scripts/benchmark/validate_results.js --benchmark-id <benchmark-id> --require-resource-samples`
- Result files or output artifacts, if present:
  - `benchmarks/results/runs/<benchmark-id>/raw/resource-samples/*.jsonl`
  - `benchmarks/results/runs/<benchmark-id>/warmup/resource-samples/*.jsonl`
  - aggregated `summary.json` with `resource_metrics`
- Known limitations or TODOs:
  - sampler is Linux-only; `scripts/benchmark/test_resource_sampler.js` skips on non-Linux platforms

### `benchmark`

- Purpose: shared benchmark harness branch before the branch-specific benchmark expansions
- Scenario: `00-live-window-query-baseline.json`
- What changed compared with `main`:
  - adds the first `scripts/benchmark/` tree
  - adds `scripts/uma/` benchmark support scripts
  - upgrades runtime/dependency baseline
- Protected resource or stream:
  - `http://localhost:3000/alice/heart/`
  - `http://localhost:3000/alice/derived/latest`
  - `http://localhost:3000/alice/derived/anomaly-alert/`
- Required UMA/ODRL policy: shared allow/deny smoke and ODRL benchmark helpers, but no branch-specific policy beyond the baseline scenario JSON
- Expected authorized behavior: baseline live registration benchmark should complete and emit websocket timing data
- Expected denied behavior: shared smoke scripts still enforce wrong-target / deny paths
- Benchmark/evaluation relevance: parent benchmark branch for later specialized benchmark branches
- Commands to run or validate the branch:
  - `npm run benchmark:live-registration -- --runs 30 --warmup 5`
  - `npm run benchmark:uma-odrl`
  - `npm run smoke:uma`
- Result files or output artifacts, if present:
  - `benchmarks/results/runs/<benchmark-id>/`
- Known limitations or TODOs:
  - no committed resource-sampling or alert-specific benchmark scripts on this branch

### `feature/stabilize-uma-headless`

- Purpose: make headless UMA execution reproducible
- Scenario: derived-resource UMA smoke and strict preflight checks
- What changed compared with `main`:
  - adds `smoke.js`, `preflight-derived.js`, `start_odrl_logged.sh`, and benchmark preparation docs
  - pins Node 22 in `.node-version` / `.nvmrc` and `Dockerfile`
- Protected resource or stream:
  - `http://localhost:3000/alice/derived/acc-x/`
  - wrong-target `http://localhost:3000/alice/derived/acc-y/`
- Required UMA/ODRL policy:
  - simple allow policy can be bootstrapped automatically for Bob
  - smoke path also expects deny and invalid-claim failures
- Expected authorized behavior:
  - challenge `401`
  - token exchange `200`
  - authorized fetch `200`
- Expected denied behavior:
  - wrong target must return `401` or `403`
  - deny identity must fail
- Benchmark/evaluation relevance: prerequisite stabilization branch for later benchmark work
- Commands to run or validate the branch:
  - `npm run smoke:uma`
  - `node scripts/uma/preflight-derived.js`
  - `bash scripts/uma/start_odrl_logged.sh`
- Result files or output artifacts, if present:
  - ODRL log path configured by `PANDA_UMA_ODRL_LOG_FILE` or `UMA_ODRL_LOG_FILE`
- Known limitations or TODOs:
  - preflight assumes CSS and UMA are already running or can be started by the logged helper

### `feature/audit-logged-query-service`

- Purpose: add query registration audit logging and actor/scope-aware reuse semantics
- Scenario: feature branch, not a separate policy scenario branch
- What changed compared with `main`:
  - adds query audit log types and file persistence
  - records `registered`, `executing`, `executed`, and `failed` statuses
  - scopes query reuse by actor and authorization scope
  - disables reuse for live queries so subscriptions are re-established
- Protected resource or stream:
  - audit file `query_audit_log.json`
  - PANDA query registration paths through `QueryHandler` / `AuditLoggedQueryService`
- Required UMA/ODRL policy:
  - no new ODRL artifact
  - authorization scope becomes part of reuse logic
- Expected authorized behavior:
  - same actor + same scope + non-live query may reuse existing execution
  - access events are recorded against the query log
- Expected denied behavior:
  - same normalized query with different actor/scope is explicitly marked `not_reused_actor_scope_mismatch`
- Benchmark/evaluation relevance: later benchmark branches build on this service
- Commands to run or validate the branch:
  - `npm test`
  - No dedicated package script for audit-log inspection is defined on the branch
- Result files or output artifacts, if present:
  - `query_audit_log.json`
  - tracked sample CSV files `uma_denial_baseline.csv` and `uma_grant_baseline.csv`
- Known limitations or TODOs:
  - branch is feature-oriented; it does not define a standalone scenario JSON

### `node-migration`

- Purpose: migrate runtime to Node 22 and introduce the first UMA benchmark runbook and tracked proof artifacts
- Scenario: derived-resource UMA benchmark proof and latency-matrix groundwork
- What changed compared with `main`:
  - pins Node 22 in `.node-version`, `.nvmrc`, `package.json`, and `Dockerfile`
  - switches `rsp-js` to `^1.3.5`
  - adds benchmark runbook and tracked benchmark result folders
- Protected resource or stream: default runbook focus is `http://localhost:3000/alice/derived/acc-x/`
- Required UMA/ODRL policy:
  - simple allow, deny, wrong-target, and invalid-claim proof through the runbook and enforcement matrix
- Expected authorized behavior:
  - smoke output should show `Challenge status=401`, `Allow exchange status=200`, `Allow fetch status=200`, and `Reuse fetch status=200`
- Expected denied behavior:
  - wrong-target fetch `403` or `401`
  - deny exchange `403`
- Benchmark/evaluation relevance: earliest branch in the inspected set with committed result artifacts
- Commands to run or validate the branch:
  - `node scripts/uma/smoke.js`
  - `./scripts/uma/benchmark_enforcement_matrix.sh`
  - `PANDA_UMA_REUSE_ACCESS_TOKEN=false WARMUP_ITERATIONS=0 ITERATIONS=20 node scripts/benchmark/uma_odrl_flow_benchmark.js`
- Result files or output artifacts, if present:
  - `benchmark-results/uma-latency-matrix-2026-04-16T13-08-41-857Z/`
  - `benchmark-results/uma-odrl-flow-2026-04-17T14-26-24-860Z.*`
  - `benchmark-results/uma-proof-20260417-162009/`
- Known limitations or TODOs:
  - tracked result folders are historical artifacts, not proof that the branch still reproduces identically today

### `codex/e2e-replayer-panda-uma-flow`

- Purpose: document and script the derived-resource E2E replay + UMA flow
- Scenario: manual/scripted live test for derived `acc-x`
- What changed compared with `main`:
  - adds exact live-test instructions and smoke helpers
  - adds benchmark README and UMA latency helpers, but no branch-local scenario JSON
- Protected resource or stream: `http://localhost:3000/alice/derived/acc-x/`
- Required UMA/ODRL policy:
  - manual Turtle example grants Bob `odrl:read` on derived `acc-x`
- Expected authorized behavior:
  - token request uses JSON body with `grant_type`, `ticket`, URL-encoded `claim_token`, and `claim_token_format`
  - final GET with bearer token returns `200`
- Expected denied behavior:
  - failure is any non-2xx final GET
- Benchmark/evaluation relevance: tooling/reproduction branch, not a dedicated scenario branch
- Commands to run or validate the branch:
  - `bash scripts/uma/LIVE_TEST_DERIVED_RESOURCE.sh`
  - `node scripts/uma/smoke.js`
- Result files or output artifacts, if present:
  - proof/debug docs under `documents/`
- Known limitations or TODOs:
  - branch does not add a branch-local scenario JSON or committed result folder

## Reproducibility

### General workflow

1. Confirm a clean enough working tree: `git status --short --branch`
2. Inspect a branch without destroying local work:
   - `git diff --name-status main...<branch>`
   - `git log --oneline --no-merges main..<branch>`
   - `git show <branch>:<path>`
3. Switch only when needed: `git switch <branch>`

### Installing dependencies

- `main` uses the original runtime/dependency set in `package.json`
- most inspected scenario and benchmark branches pin Node 22 via `.node-version`, `.nvmrc`, or `"engines": { "node": ">=22 <25" }`
- typical install path on those branches is:
  - `npm install`
  - if the branch contains `replayer/`, also install there when needed

### Starting PANDA / CSS / UMA / replayer components

- CSS / UMA:
  - use the forked UMA server at `https://github.com/argahsuknesib/user-managed-access`
  - branch runbooks repeatedly reference the sibling `user-managed-access` repo and `corepack yarn start:odrl`
  - several branches also expect `corepack yarn run script:setup-alice-derived`
  - TODO: pin the exact compatible UMA branch or commit in the relevant runbook or branch-specific setup instructions if/when maintainers confirm it

Operational setup snippet:

```text
1. Clone https://github.com/argahsuknesib/user-managed-access.
2. Install dependencies by following that repository's README.
3. Run the UMA/CSS components from that repository when reproducing PANDA.
4. Do not assume an arbitrary upstream/default UMA server is compatible with PANDA.
5. TODO: pin the exact compatible UMA branch or commit for archival reproducibility.
```
- PANDA:
  - `npm run start`
- UMA smoke / preflight:
  - `npm run smoke:uma`
  - `node scripts/uma/preflight-derived.js`
- Replayer:
  - baseline live source replay: `node scripts/benchmark/live_heart_replayer.js --url http://localhost:3000/alice/heart/ ...`
  - real stream replay in protected scenarios: `node scripts/benchmark/run_real_stream_replayer.js --target-url http://localhost:3000/alice/heart/ --dataset-relative-path data/heart.nt ...`

### Running tests or benchmarks

- Shared benchmark harness:
  - `node scripts/benchmark/run_all_scenarios.js --mode smoke --runs 1 --warmup 0`
- Live registration benchmark:
  - `npm run benchmark:live-registration -- --runs 30 --warmup 5`
- UMA latency benchmark:
  - `npm run benchmark:uma-odrl`
- Alert benchmarks:
  - `npm run benchmark:protected-alert-access`
  - `npm run benchmark:protected-alert-lifecycle`
- Policy-size benchmark:
  - `npm run benchmark:odrl-policy-graph-size:generate`
  - `npm run benchmark:odrl-policy-graph-size`
- Concurrent benchmark:
  - `node scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js --force`

### Where outputs are written

- Scenario harness: `benchmarks/results/runs/<benchmark-id>/`
- Alert benchmarks: `benchmark-results/protected-alert-access-<run-id>/` and `benchmark-results/protected-alert-lifecycle-<run-id>/`
- Policy-size benchmark: branch-configured output directory plus generated policies under `benchmarks/generated/odrl-policy-graph-size/`
- Node migration proof artifacts: `benchmark-results/uma-*`
- CPU/memory resource samples: `benchmarks/results/runs/<benchmark-id>/{raw,warmup}/resource-samples/*.jsonl`

### How to interpret success or failure

- success indicators are branch-specific, but the common required signals are:
  - protected resource does not return `200` before authorization
  - UMA challenge includes a ticket
  - token exchange succeeds for the allowed identity
  - authorized GET returns `200`
  - branch-specific summary/validation scripts report pass
- failure indicators include:
  - public protected resources
  - missing `WWW-Authenticate: UMA ...`
  - deny identity accidentally receiving `200`
  - missing current-run alert/protected-result evidence
  - missing resource samples when `--require-resource-samples` is enabled

## Maintenance

### How to add a new branch to this document

1. Confirm the branch exists locally or on `origin`
2. Record `git diff --name-status main...<branch>` and `git log --oneline --no-merges main..<branch>`
3. Extract:
   - scenario JSON files
   - package script additions
   - benchmark scripts and validators
   - policy/meta/config files
   - result/output directories if any are committed
4. Add one overview-row entry and one branch-details subsection
5. If the branch changes an existing policy category, update that section too

### What must be documented for any new policy scenario

- actor / assignee identity
- target resource or endpoint
- action
- any purpose, source, time-window, or dataset constraints
- expected authorized behavior
- expected denied behavior
- exact evidence files
- whether the policy is tracked as code, scenario metadata, or only in docs

### What benchmark metadata and results must be recorded

- benchmark entry point or package script
- output directory pattern
- summary file names
- scenario IDs
- iteration and warmup counts
- any resource-sampling settings
- whether results are raw historical artifacts or generated by validators in the branch

### Warning on stale result folders

Committed result folders are historical artifacts unless the benchmark runner for the current branch still points to them and the run metadata matches the configured iteration range. Do not treat stale folders as active benchmark data just because they are present in the repository. This matters especially for:

- `benchmark-results/uma-*` on `node-migration`
- any latest-run lookup logic that reads the newest timestamped directory
- any branch where validators assume `runs`, `warmup`, or current `benchmark_run_id` values
