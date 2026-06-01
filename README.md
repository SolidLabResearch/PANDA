# PANDA

PANDA (Privacy-preserving platform for ANomaly Detection in healthcare streAms) is a research platform for anomaly detection on healthcare data streams with privacy-preserving access control.
It uses [Solid](https://solidproject.org/) for data storage, [User Managed Access (UMA)](https://github.com/solidLabResearch/user-managed-access), and policy-based access control so patients can define granular permissions for stream access.

PANDA must be reproduced with the forked UMA server at [argahsuknesib/user-managed-access](https://github.com/argahsuknesib/user-managed-access), not an arbitrary upstream/default UMA server. PANDA depends on UMA/CSS support for derived resources, so the fork should be cloned and used for PANDA experiments unless a maintainer has pinned a different compatible branch or commit.

## Repository purpose

This repository serves as a research artifact for PANDA:
- documenting benchmark branches and policy variants,
- capturing reproducible scenario definitions, and
- providing representative queries, rules, and dataset references used in the evaluation context.

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/BRANCHES_AND_POLICIES.md](docs/BRANCHES_AND_POLICIES.md) | Overview of branch structure, benchmark branches, and policy-related mapping. |
| [docs/SCENARIOS_AND_REPRODUCIBILITY.md](docs/SCENARIOS_AND_REPRODUCIBILITY.md) | Scenario descriptions and reproducibility guidance. |
| [docs/policies/example-heart-policy.ttl](docs/policies/example-heart-policy.ttl) | Canonical PANDA-facing example UMA/ODRL policy for the heart/IBI scenario. |
| [docs/data/DATASETS.md](docs/data/DATASETS.md) | Dataset inventory and related notes. |
| [docs/queries/rspql/heart_ibi_window.rq](docs/queries/rspql/heart_ibi_window.rq) | Example RSP-QL query for heart/IBI window processing. |
| [docs/rules/n3/anomaly_detection.n3](docs/rules/n3/anomaly_detection.n3) | Example N3 rules for anomaly detection logic. |

## Linting

You run the linter via 
```shell
npm run lint:ts
```

You can automatically fix some issues via
```shell
npm run lint:ts:fix
```

## Branches and benchmark scenarios

See [docs/BRANCHES_AND_POLICIES.md](docs/BRANCHES_AND_POLICIES.md) for branch structure, benchmark scenario mapping, and policy context.

## Scenarios, queries, rules, and data

See [docs/SCENARIOS_AND_REPRODUCIBILITY.md](docs/SCENARIOS_AND_REPRODUCIBILITY.md) for scenario definitions and reproducibility details, with pointers to associated queries, rules, and datasets.

## License

This code is copyrighted by [Ghent University - imec](https://www.ugent.be/ea/idlab/en) and released under the [MIT Licence](./LICENCE).

## Contact

For any questions, please contact [Kush](mailto:mailkushbisen@gmail.com) or create an issue in the repository [here](https://github.com/SolidLabResearch/privacy-dashboard-stream/issues).
