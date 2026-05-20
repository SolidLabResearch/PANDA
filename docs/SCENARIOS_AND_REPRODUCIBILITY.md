# PANDA scenarios and reproducibility

This document captures reproducibility details for PANDA evaluation scenarios, including queries, rules, policies, data dependencies, and execution expectations.

## Scenario: RSP-QL heart/IBI monitoring

### Purpose

TODO: Describe the objective of the heart/IBI monitoring scenario.

### Related branches

- `baseline-scenario` (TODO: confirm)
- `limited-access-caregiver-scenario` (TODO: confirm)
- `policy-based-denial` (TODO: confirm)
- `protected-alert` (TODO: confirm)
- `authorized-caregiver-alert-read-benchmark` (TODO: confirm)
- `policy-size-benchmark` (TODO: confirm)
- `concurrent-requests` (TODO: confirm)
- `benchmark-cpu-memory` (TODO: confirm)

### Input data

TODO: Specify the required input stream(s), dataset(s), and format(s).

See also: [docs/data/DATASETS.md](data/DATASETS.md).

### RSP-QL query

TODO: Confirm and insert the exact RSP-QL query used for this scenario.

Reference placeholder file: [docs/queries/rspql/heart_ibi_window.rq](queries/rspql/heart_ibi_window.rq).

### Notation3 rule

TODO: Confirm and insert the exact Notation3 rule(s) used for anomaly detection or derived processing.

Reference placeholder file: [docs/rules/n3/anomaly_detection.n3](rules/n3/anomaly_detection.n3).

### UMA/ODRL policy

TODO: Describe the required UMA/ODRL policy for this scenario.

Suggested fields:
- assignee:
- target:
- action:
- purpose constraint:
- source/data constraint:
- additional constraints:

### Benchmark command

TODO: Add the exact command(s) required to reproduce this scenario.

Example placeholder:

```bash
git checkout <branch-name>
npm install
npm run build
# TODO: add exact benchmark command
```

### Expected behavior

Authorized case:

TODO.

Denied case:

TODO.

### Expected output

TODO: Describe expected logs, metrics, files, or benchmark artifacts.

### TODOs before publication

- TODO: Replace placeholders with final query/rule/policy content.
- TODO: Confirm branch-to-scenario mapping.
- TODO: Confirm exact dataset source and reproducibility constraints.
- TODO: Confirm exact benchmark command and expected outputs.
