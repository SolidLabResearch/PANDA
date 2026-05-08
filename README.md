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

## Benchmarking

Benchmark harnesses live under [`scripts/benchmark`](./scripts/benchmark). For the live websocket registration path, start PANDA with `BENCHMARK_TIMING=1` and run:

```shell
npm run benchmark:live-registration -- --runs 30 --warmup 5
```

## License

This code is copyrighted by [Ghent University - imec](https://www.ugent.be/ea/idlab/en) and released under the [MIT Licence](./LICENCE) 

## Contact

For any questions, please contact [Kush](mailto:mailkushbisen@gmail.com) or create an issue in the repository [here](https://github.com/SolidLabResearch/privacy-dashboard-stream/issues) .
