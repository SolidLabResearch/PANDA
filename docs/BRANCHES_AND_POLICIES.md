# PANDA branches and policy scenarios

This document maps PANDA branches to:
- the scenario implemented by the branch
- the protected resource or stream involved
- the required UMA/ODRL policy setup
- the expected authorized and denied behavior
- the benchmark or evaluation purpose

`main` should be treated as the stable base branch unless a scenario explicitly requires another branch.

## Branch overview

| Branch | Purpose | Main scenario | Required policy | Intended use | Status / TODO |
|---|---|---|---|---|---|
| `main` | Stable base branch | Core PANDA codebase | TODO | Base development and integration | TODO: Confirm default policy assumptions for `main` |
| `baseline-scenario` | Scenario-specific branch | Baseline authorization scenario | Baseline allow policy | Baseline scenario validation and comparison | TODO |
| `limited-access-caregiver-scenario` | Scenario-specific branch | Limited caregiver access scenario | Limited caregiver access policy | Validate constrained caregiver access behavior | TODO |
| `policy-based-denial` | Scenario-specific branch | Explicit policy denial scenario | Policy-based denial policy | Validate denied access handling and behavior | TODO |
| `protected-alert` | Scenario-specific branch | Protected alert access scenario | Protected alert policy | Validate alert resource protection behavior | TODO |
| `authorized-caregiver-alert-read-benchmark` | Benchmark branch | Authorized caregiver alert-read benchmark scenario | Protected alert policy / TODO | Measure authorized caregiver alert-read behavior | TODO: Confirm exact benchmark setup |
| `policy-size-benchmark` | Benchmark branch | Policy size and complexity benchmark scenario | Policy-size and complexity policies | Measure effect of policy size/complexity | TODO |
| `concurrent-requests` | Benchmark branch | Concurrent access request scenario | Concurrent request policy | Evaluate behavior under concurrent requests | TODO |
| `benchmark-cpu-memory` | Benchmark branch | CPU and memory evaluation scenario | TODO | Performance profiling (CPU/memory) | TODO |
| `benchmark` | Benchmark branch | General benchmarking scenario | TODO | Shared benchmarking workflows | TODO |
| `feature/stabilize-uma-headless` | Feature branch | UMA headless stabilization work | TODO | Development and stabilization of UMA headless flow | TODO |
| `feature/audit-logged-query-service` | Feature branch | Audit-logged query-service work | TODO | Development of audit logging/query-service behavior | TODO |
| `node-migration` | Migration branch | Node/runtime migration scenario | TODO | Migration and compatibility validation | TODO |
| `codex/e2e-replayer-panda-uma-flow` | Tooling/E2E branch | E2E PANDA UMA flow replay scenario | TODO | End-to-end replay and validation tooling | TODO |

## Policy categories

### Baseline allow policy

#### Used by branches

- `baseline-scenario`
- `main` (TODO: confirm whether baseline policy is directly used in `main` workflows)

#### Purpose

Provide a baseline authorization configuration that permits expected access for the core PANDA scenario.

#### Required policy elements

- assignee: TODO
- target: TODO
- action: TODO
- purpose constraint: TODO
- source/data constraint: TODO
- additional constraints: TODO

#### Expected authorized behavior

TODO.

#### Expected denied behavior

TODO.

#### TODOs before publication

- TODO: Confirm exact ODRL rule structure.
- TODO: Confirm concrete protected resources and actors.

### Limited caregiver access policy

#### Used by branches

- `limited-access-caregiver-scenario`

#### Purpose

Constrain caregiver access to a limited subset of data/actions defined by policy.

#### Required policy elements

- assignee: TODO
- target: TODO
- action: TODO
- purpose constraint: TODO
- source/data constraint: TODO
- additional constraints: TODO

#### Expected authorized behavior

TODO.

#### Expected denied behavior

TODO.

#### TODOs before publication

- TODO: Confirm caregiver identity model and assignment mechanism.
- TODO: Confirm exact allowed versus denied resource/action matrix.

### Policy-based denial policy

#### Used by branches

- `policy-based-denial`

#### Purpose

Enforce explicit denial outcomes for disallowed requests according to policy constraints.

#### Required policy elements

- assignee: TODO
- target: TODO
- action: TODO
- purpose constraint: TODO
- source/data constraint: TODO
- additional constraints: TODO

#### Expected authorized behavior

TODO.

#### Expected denied behavior

TODO.

#### TODOs before publication

- TODO: Confirm denial trigger conditions and expected status/error behavior.

### Protected alert policy

#### Used by branches

- `protected-alert`
- `authorized-caregiver-alert-read-benchmark`

#### Purpose

Protect alert resources/streams and allow only authorized alert read/access patterns.

#### Required policy elements

- assignee: TODO
- target: TODO
- action: TODO
- purpose constraint: TODO
- source/data constraint: TODO
- additional constraints: TODO

#### Expected authorized behavior

TODO.

#### Expected denied behavior

TODO.

#### TODOs before publication

- TODO: Confirm alert resource naming and access paths.
- TODO: Confirm benchmark-specific policy deltas for authorized caregiver alert reads.

### Policy-size and complexity policies

#### Used by branches

- `policy-size-benchmark`

#### Purpose

Evaluate how policy size and structural complexity affect authorization and system performance.

#### Required policy elements

- assignee: TODO
- target: TODO
- action: TODO
- purpose constraint: TODO
- source/data constraint: TODO
- additional constraints: TODO (e.g., rule count, nesting, constraints)

#### Expected authorized behavior

TODO.

#### Expected denied behavior

TODO.

#### TODOs before publication

- TODO: Define policy-size tiers and complexity dimensions used in benchmarks.
- TODO: Confirm workload and measurement methodology.

### Concurrent request policy

#### Used by branches

- `concurrent-requests`

#### Purpose

Validate authorization behavior and consistency under concurrent request load.

#### Required policy elements

- assignee: TODO
- target: TODO
- action: TODO
- purpose constraint: TODO
- source/data constraint: TODO
- additional constraints: TODO (e.g., request/session scope)

#### Expected authorized behavior

TODO.

#### Expected denied behavior

TODO.

#### TODOs before publication

- TODO: Confirm concurrency model and benchmark request patterns.
- TODO: Confirm expected consistency guarantees and result validation checks.

## Branch details

### `baseline-scenario`

Related scenario: [Scenario: RSP-QL heart/IBI monitoring](SCENARIOS_AND_REPRODUCIBILITY.md#scenario-rsp-ql-heartibi-monitoring) (TODO: confirm exact scenario mapping)

#### Purpose

TODO: Explain what this branch implements.

#### Scenario

TODO: Describe the PANDA scenario represented by this branch.

#### Protected resource or stream

TODO: Specify the Solid resource, derived resource, alert resource, stream, or container protected in this scenario.

#### Required UMA/ODRL policy

TODO: Describe the required policy.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

#### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

#### Benchmark or evaluation relevance

TODO: Explain how this branch supports the PANDA evaluation.

#### Commands

TODO: Add commands needed to run this branch.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add scenario-specific command
```

### `limited-access-caregiver-scenario`

Related scenario: [Scenario: RSP-QL heart/IBI monitoring](SCENARIOS_AND_REPRODUCIBILITY.md#scenario-rsp-ql-heartibi-monitoring) (TODO: confirm exact scenario mapping)

#### Purpose

TODO: Explain what this branch implements.

#### Scenario

TODO: Describe the PANDA scenario represented by this branch.

#### Protected resource or stream

TODO: Specify the Solid resource, derived resource, alert resource, stream, or container protected in this scenario.

#### Required UMA/ODRL policy

TODO: Describe the required policy.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

#### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

#### Benchmark or evaluation relevance

TODO: Explain how this branch supports the PANDA evaluation.

#### Commands

TODO: Add commands needed to run this branch.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add scenario-specific command
```

### `policy-based-denial`

Related scenario: [Scenario: RSP-QL heart/IBI monitoring](SCENARIOS_AND_REPRODUCIBILITY.md#scenario-rsp-ql-heartibi-monitoring) (TODO: confirm exact scenario mapping)

#### Purpose

TODO: Explain what this branch implements.

#### Scenario

TODO: Describe the PANDA scenario represented by this branch.

#### Protected resource or stream

TODO: Specify the Solid resource, derived resource, alert resource, stream, or container protected in this scenario.

#### Required UMA/ODRL policy

TODO: Describe the required policy.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

#### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

#### Benchmark or evaluation relevance

TODO: Explain how this branch supports the PANDA evaluation.

#### Commands

TODO: Add commands needed to run this branch.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add scenario-specific command
```

### `protected-alert`

Related scenario: [Scenario: RSP-QL heart/IBI monitoring](SCENARIOS_AND_REPRODUCIBILITY.md#scenario-rsp-ql-heartibi-monitoring) (TODO: confirm exact scenario mapping)

#### Purpose

TODO: Explain what this branch implements.

#### Scenario

TODO: Describe the PANDA scenario represented by this branch.

#### Protected resource or stream

TODO: Specify the Solid resource, derived resource, alert resource, stream, or container protected in this scenario.

#### Required UMA/ODRL policy

TODO: Describe the required policy.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

#### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

#### Benchmark or evaluation relevance

TODO: Explain how this branch supports the PANDA evaluation.

#### Commands

TODO: Add commands needed to run this branch.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add scenario-specific command
```

### `authorized-caregiver-alert-read-benchmark`

Related scenario: [Scenario: RSP-QL heart/IBI monitoring](SCENARIOS_AND_REPRODUCIBILITY.md#scenario-rsp-ql-heartibi-monitoring) (TODO: confirm exact scenario mapping)

#### Purpose

TODO: Explain what this branch implements.

#### Scenario

TODO: Describe the PANDA scenario represented by this branch.

#### Protected resource or stream

TODO: Specify the Solid resource, derived resource, alert resource, stream, or container protected in this scenario.

#### Required UMA/ODRL policy

TODO: Describe the required policy.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

#### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

#### Benchmark or evaluation relevance

TODO: Explain how this branch supports the PANDA evaluation.

#### Commands

TODO: Add commands needed to run this branch.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add scenario-specific command
```

### `policy-size-benchmark`

Related scenario: [Scenario: RSP-QL heart/IBI monitoring](SCENARIOS_AND_REPRODUCIBILITY.md#scenario-rsp-ql-heartibi-monitoring) (TODO: confirm exact scenario mapping)

#### Purpose

TODO: Explain what this branch implements.

#### Scenario

TODO: Describe the PANDA scenario represented by this branch.

#### Protected resource or stream

TODO: Specify the Solid resource, derived resource, alert resource, stream, or container protected in this scenario.

#### Required UMA/ODRL policy

TODO: Describe the required policy.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

#### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

#### Benchmark or evaluation relevance

TODO: Explain how this branch supports the PANDA evaluation.

#### Commands

TODO: Add commands needed to run this branch.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add scenario-specific command
```

### `concurrent-requests`

Related scenario: [Scenario: RSP-QL heart/IBI monitoring](SCENARIOS_AND_REPRODUCIBILITY.md#scenario-rsp-ql-heartibi-monitoring) (TODO: confirm exact scenario mapping)

#### Purpose

TODO: Explain what this branch implements.

#### Scenario

TODO: Describe the PANDA scenario represented by this branch.

#### Protected resource or stream

TODO: Specify the Solid resource, derived resource, alert resource, stream, or container protected in this scenario.

#### Required UMA/ODRL policy

TODO: Describe the required policy.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

#### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

#### Benchmark or evaluation relevance

TODO: Explain how this branch supports the PANDA evaluation.

#### Commands

TODO: Add commands needed to run this branch.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add scenario-specific command
```

### `benchmark-cpu-memory`

Related scenario: [Scenario: RSP-QL heart/IBI monitoring](SCENARIOS_AND_REPRODUCIBILITY.md#scenario-rsp-ql-heartibi-monitoring) (TODO: confirm exact scenario mapping)

#### Purpose

TODO: Explain what this branch implements.

#### Scenario

TODO: Describe the PANDA scenario represented by this branch.

#### Protected resource or stream

TODO: Specify the Solid resource, derived resource, alert resource, stream, or container protected in this scenario.

#### Required UMA/ODRL policy

TODO: Describe the required policy.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

#### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

#### Benchmark or evaluation relevance

TODO: Explain how this branch supports the PANDA evaluation.

#### Commands

TODO: Add commands needed to run this branch.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add scenario-specific command
```
