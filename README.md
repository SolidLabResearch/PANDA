# PANDA

The repository contains the code for the Privacy-preserving platform for ANomaly Detection in healthcare streAms (PANDA) platform, which is a service vor monitoring the health of patients to detect anomalies in their health data streams. To enable privacy, PANDA utilizes [Solid](https://solidproject.org/) as a data storage solution and extends it with [User Managed Access](https://github.com/solidLabResearch/user-managed-access) to allow the patients to specify granular access control policies for their data streams. 


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

This repository contains several scenario-specific and benchmark-specific branches for PANDA. These branches correspond to different UMA/ODRL policy setups, access-control scenarios, and evaluation variants.

See [docs/BRANCHES_AND_POLICIES.md](docs/BRANCHES_AND_POLICIES.md) for an overview of each branch, the scenario it represents, and the policies required to run it.

## Scenarios, queries, rules, and data

- [docs/BRANCHES_AND_POLICIES.md](docs/BRANCHES_AND_POLICIES.md)
- [docs/SCENARIOS_AND_REPRODUCIBILITY.md](docs/SCENARIOS_AND_REPRODUCIBILITY.md)

## License

This code is copyrighted by [Ghent University - imec](https://www.ugent.be/ea/idlab/en) and released under the [MIT Licence](./LICENCE) 

## Contact

For any questions, please contact [Kush](mailto:mailkushbisen@gmail.com) or create an issue in the repository [here](https://github.com/SolidLabResearch/privacy-dashboard-stream/issues) .
