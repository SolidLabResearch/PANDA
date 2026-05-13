# Policy Aware Decentralized Stream Replayer

A simpler sensor data replayer to the inbox of an LDES in LDP or any LDP container which works with the UMA flow of the Solid Pod.

## Usage

### Installation

```bash
npm install
```

### Building

Now, navigate to the `src/config` folder and update the `config.json` file with the required parameters.

```json
{
    "streams": [
        {
            "location": "insert_location_here",
            "file_location": "insert_file_location_here"
        }
    ],
    "frequency_event": 4,
    "frequency_buffer": 4,
    "is_ldes": true,
    "tree_path": "https://saref.etsi.org/core/hasTimestamp"
}
```

If the `is_ldes` parameter is set to `true`, each stream `location` should point to an LDES stream URL and the replayer resolves its inbox per stream target. If `is_ldes` is `false`, each stream `location` is used directly as the LDP container.

Now, build the project using the following command:

```bash
npm run build
```

### Running

To run the project, use the following command:

```bash
npm run start
```

## License

This code is copyrighted by [Ghent University - imec](https://www.ugent.be/ea/idlab/en) and released under the [MIT Licence](./LICENCE.md) 

## Contact

For any questions, please contact [Kush](mailto:kushagrasingh.bisen@ugent.be) or create an issue in the repository.
