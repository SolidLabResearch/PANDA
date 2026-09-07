# PANDA

PANDA is the **Privacy-preserving platform for ANomaly Detection in healthcare streAms**. It is a research prototype for monitoring healthcare RDF streams stored in decentralized [Solid](https://solidproject.org/) environments. A monitoring request supplies an RSP-QL query and N3 rules; PANDA reads the referenced LDES stream, processes it with rsp-js, applies the rules with N3/EYE, and returns the resulting RDF event over WebSocket.

PANDA is an academic research artifact, not a production healthcare service. The main branch contains the core TypeScript application and supporting examples. Benchmark harnesses and several policy scenarios live on separate branches; they are not all reproducible by checking out main.

## How PANDA works

The active request path is:

1. A client opens a WebSocket connection to PANDA and sends JSON containing a query, N3 rules, and a query type (live or historical+live).
2. The query contains complete LDES stream URLs in FROM NAMED WINDOW ... ON STREAM <...> clauses. On main, PANDA does not perform Type Index discovery in this path; TypeIndexLDESLocator and related helpers are utilities, not the active request flow.
3. PANDA derives a corresponding /derived/<last-path-segment> resource for each stream and pre-authorizes it with ReuseTokenUMAFetcher. The fetcher reuses cached tokens or follows the UMA challenge, ticket, RPT, and authorized-request flow. The active server uses a fixed replayer WebID claim.
4. For live, NotificationStreamProcessor subscribes through Solid WebhookChannel2023 notifications. The PANDA HTTP server receives Add notifications, reads the derived event resource with UMA, and emits the event to the RSP pipeline.
5. For historical+live, DecentralizedFileStreamer reads LDES members from now - RANGE to now, adds them to rsp-js in chronological order, and subscribes for later events.
6. rsp-js evaluates the RSP-QL window and emits an aggregation binding. PANDA wraps the value in RDF with a timestamp, window bounds, provenance, and source-stream links.
7. ContinuousAnomalyMonitoringService parses the aggregation event and rules, runs eyereasoner, and serializes inferred quads.
8. The reasoned event is sent to the PANDA WebSocket server and forwarded to clients associated with the query hash.

~~~mermaid
sequenceDiagram
    participant C as Monitoring client
    participant P as PANDA WebSocket/HTTP server
    participant S as Solid Pod / LDES
    participant U as UMA authorization server
    participant N as Solid notification channel
    participant R as rsp-js
    participant E as N3/EYE reasoner

    C->>P: WebSocket {type, query, rules}
    P->>S: Read or subscribe to stream
    P->>U: UMA challenge, ticket, RPT when needed
    S-->>N: WebhookChannel2023 Add notification
    N-->>P: POST notification {type: Add, target}
    P->>S: Authorized GET of derived event
    P->>R: Add timestamped RDF quads
    R-->>P: RStream aggregation binding
    P->>E: Aggregation RDF + N3 rules
    E-->>P: Inferred RDF quads
    P-->>C: WebSocket aggregation result
~~~

Solid Pods / Community Solid Server provide LDP resources and the local development server. UMA provides challenge-based access-token acquisition. ODRL policies are enforced by the compatible UMA server used by scenario branches; PANDA itself does not evaluate ODRL policy graphs on main. LDES-in-LDP libraries provide stream metadata, fragments, and members. Solid notifications deliver new-event notifications. RSP-QL and rsp-js provide windowed stream processing. N3 and EYE provide rule-based inference for anomaly detection.

## Repository structure

| Path | Role |
| --- | --- |
| src/server/ | HTTP and WebSocket handling, RSP-QL parsing at the server boundary, and the aggregation-query helper. |
| src/service/aggregator/ | Historical LDES reading and live notification-to-rsp-js ingestion. |
| src/service/authorization/ | UMA fetchers and in-memory access-token/RPT caches. |
| src/service/reasoner/ | N3 parsing and EYE reasoning for generated aggregation events. |
| src/service/query-registry/ | Query registration, equivalence checks, duplicate handling, and query audit-log writing. |
| src/service/result-dispatcher/ | Aggregated-result retrieval and WebSocket result-channel helpers. |
| src/service/publishing-stream-to-pod/ | LDES result publication and function-ontology query metadata; publication is not enabled by current startup. |
| src/utils/ | Type Index/stream utilities, LDES event helpers, authentication helpers, queues, algorithms, and logging support. |
| src/config/ | Runtime JSON settings and credential/token mappings. |
| src/static/ | The static description page copied to dist/static by the start scripts. |
| scripts/ | Community Solid Server configurations, pod setup helpers, and UMA utilities. |
| docs/ | Branch/policy mappings, scenario/reproducibility notes, dataset notes, and heart/IBI examples. |

## Prerequisites

PANDA is a Node.js/TypeScript project. package.json does not declare a Node version; use a Node/npm combination compatible with the checked-in dependencies and TypeScript configuration.

The important non-registry dependency is:

~~~json
"rsp-js": "file:../RSP/RSP-JS"
~~~

The path is relative to the PANDA repository. A compatible RSP-JS checkout must exist before installing PANDA, for example:

~~~text
workspace/
├── PANDA/
└── RSP/
    └── RSP-JS/
~~~

The PANDA repository does not specify an RSP-JS clone URL. Obtain the compatible checkout separately and place it at the path above; otherwise npm install/npm ci cannot resolve the local dependency. The lockfile records the expected local package as rsp-js version 2.8.3, but the compatible source revision is not pinned by PANDA main.

UMA scenario work must use the PANDA-compatible fork [argahsuknesib/user-managed-access](https://github.com/argahsuknesib/user-managed-access), not an arbitrary upstream UMA server. Repository documentation identifies derived-resource support in this fork as a practical requirement. main does not pin a compatible UMA branch or commit, so archival reproduction still requires recording that revision separately.

## Installation

Clone PANDA and install it after placing RSP-JS at the adjacent path:

~~~bash
git clone https://github.com/SolidLabResearch/PANDA.git
cd PANDA
# Place a compatible RSP-JS checkout at ../RSP/RSP-JS first.
npm install
~~~

PANDA alone is not sufficient for a complete policy-controlled run. You also need a Solid server with the resources and notification behavior expected by the query, the compatible UMA deployment for authorization scenarios, and healthcare stream data. The repository includes Community Solid Server configuration files and seeded local pod metadata, but not the external UMA server or a complete healthcare dataset.

## Configuration

The configuration is JSON imported directly by TypeScript. Repository files include development/example credentials; do not copy them into a deployment or publish new secrets. Replace them locally and keep real credentials out of version control.

| File | Purpose | Important fields |
| --- | --- | --- |
| src/config/aggregator_config.json | Aggregation-pod LDES location and rate limit used by duplicate-query retrieval. | aggregation_pod_ldes_location, aggregator_rate_limit |
| src/config/aggregator_setup.json | Destination URLs used when creating webhook subscriptions. | aggregator_http_server_url; aggregator_ws_server_url is present, although the active subscription helper uses the HTTP value. |
| src/config/ldes_properties.json | Aggregation LDES and result-publishing settings. | LIL_URL, TREE_PATH, BUCKET_SIZE, LOG_LEVEL |
| src/config/PodToken.json | Exact source-stream URL to CSS client-credential mapping for historical reads. | URL keys, id, secret, idp |
| src/config/pod_credentials.json | Aggregation-pod WebID and account credentials used when the LDES publisher is initialized. | aggregation_pod_web_id, aggregation_pod_email, aggregation_pod_password |
| src/server/aggregator-pod/config.json and account.json | Optional local aggregation-pod Community Solid Server configuration and seeded account. | CSS imports and aggregation_pod account |
| scripts/pod/config/*.json and scripts/pod/pod_credentials.json | Community Solid Server configurations used by start-solid-server scripts. | CSS imports and seeded pod setup |

When changing the Solid server location, update the stream URL in the RSP-QL query, the matching key and idp in src/config/PodToken.json for historical reads, aggregation-pod URLs, and aggregator_setup.json for webhook delivery. The active notification helper also has a hard-coded subscription-server URL, so changing only JSON files does not relocate all notification traffic.

The CLI accepts a Solid-server option, but the current action passes options.SolidServer while Commander creates solid_server_url; HTTPServer also stores this value without using it for discovery or fetching. Configure concrete URLs above instead.

## Running PANDA

### Local Solid server

The repository provides:

~~~bash
npm run start-solid-server
~~~

This changes into scripts/, removes data/.internal/accounts, and starts Community Solid Server with scripts/pod/config/unsafe.json and the seeded pod configuration. Checked-in queries and authentication helpers use http://localhost:3000/ as the expected local Solid base URL. The unsafe configuration imports allow-all; it is for development, not policy enforcement.

Other available scripts are:

~~~bash
npm run restart-solid-server
npm run start-solid-server-extended-lock
npm run test-run
~~~

They select the corresponding checked-in CSS configuration. test-run uses scripts/pod/config/auth.json, disables notification configuration, and starts one CSS worker. No package script starts the external UMA fork; that setup is scenario-specific.

### PANDA server

Run PANDA in another shell:

~~~bash
npm run start-monitoring
~~~

This compiles TypeScript, copies src/static to dist/static, and runs dist/index.js monitoring. The monitoring command accepts:

~~~text
-p, --port <port>                       default: 8080
-ss, --solid_server_url <SolidServer>   default: http://localhost:3000/
~~~

The long form is --solid_server_url. The supplied Solid-server value is currently not passed under the property name expected by the action and is not used by the active stream path.

Related scripts:

- npm run start compiles and starts dist/index.js without monitoring. The current Commander program therefore does not construct HTTPServer; use start-monitoring for the intended server command.
- npm run start-log uses the monitoring command but redirects stdout to logs/output.log; the repository does not create or track logs/.
- start_aggregator_parent_process.ts forks dist/index.js with an aggregation argument, but index.ts defines only monitoring. It is not a current replacement for start-monitoring.

PANDA and internal helper clients connect to ws://localhost:8080/ using the subprotocol solid-stream-aggregator-protocol. The source has no separate UMA startup command or fully local notification topology on main; a successful live run depends on aligning the Solid notification server and aggregator_setup.json with the PANDA instance.

## Using PANDA

There is no implemented HTTP endpoint for submitting a monitoring query. Submit queries over WebSocket to the PANDA port, normally ws://localhost:8080/, with the exact subprotocol solid-stream-aggregator-protocol.

### Query message

The first message must be JSON with at least:

~~~json
{
  "type": "live",
  "query": "PREFIX saref: <https://saref.etsi.org/core/>\\nPREFIX : <https://rsp.js/>\\nREGISTER RStream <output> AS\\nSELECT (MAX(?o) AS ?MaxValue)\\nFROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/heart/> [RANGE 60000 STEP 60000]\\nWHERE { WINDOW :w1 { ?s saref:relatesToProperty <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.ibi> . ?s saref:hasValue ?o . } }",
  "rules": "@prefix math: <http://www.w3.org/2000/10/swap/math#> . @prefix ex: <http://example.org/> . @prefix saref: <https://saref.etsi.org/core/> . { ?s saref:hasValue ?value . ?value math:greaterThan 99.9 . } => { ?s ex:alert \\\"ALERT\\\" . } ."
}
~~~

The parser expects REGISTER RStream <output> AS and window definitions in the form FROM NAMED WINDOW ... ON STREAM <...> [RANGE <number> STEP <number>]. The example uses milliseconds, matching the checked-in heart/IBI query. Accepted query types are exactly live and historical+live; other values throw an unsupported-query error.

The stream URL is the full LDES URL in the query. PANDA accepts no separate stream parameter or request body for this operation. live subscribes and processes subsequent Add notifications. historical+live reads the current RANGE interval and then listens for new events.

### Authorization behavior

On registration, PANDA transforms:

~~~text
http://localhost:3000/alice/heart/
~~~

into:

~~~text
http://localhost:3000/alice/heart/derived/heart
~~~

It calls the UMA fetcher for that target. The fetcher first tries a cached token, then a tokenless request, parses the WWW-Authenticate UMA challenge, posts an UMA-ticket request with the configured claim, caches the RPT, and retries. Historical file reads additionally use the exact URL-to-CSS-credentials mapping in src/config/PodToken.json.

A policy must cover the resource that the code actually requests, not only the source stream. The example policy in [docs/policies/example-heart-policy.ttl](docs/policies/example-heart-policy.ttl) shows source, derived-resource, notification-channel, and benchmark-purpose permissions, but is an example policy shape rather than a complete main startup procedure. The active claim identity and policy assignee must agree in a real deployment.

### Results

Generated results are JSON WebSocket messages associated with the MD5 query hash:

~~~json
{
  "query_hash": "<md5-of-query>",
  "aggregation_event": "<serialized inferred RDF>",
  "aggregation_window_from": "<ISO date>",
  "aggregation_window_to": "<ISO date>"
}
~~~

aggregation_event is an RDF string. The generated event contains a saref:Measurement, saref:hasTimestamp, saref:hasValue, provenance, window bounds, and prov:generatedBy links. The reasoner returns serialized inferred quads, such as an anomaly alert when a rule matches.

The HTTP server also accepts POST requests as the internal Solid webhook receiver. A JSON body with type: "Add" and target causes it to remove the numeric event suffix, derive the event resource, fetch it with UMA, and emit the fetched Turtle to the matching RSP stream. This is not a public query API. The verified notification shape can be exercised with:

~~~bash
curl -i -X POST http://localhost:8080/ \\
  -H 'Content-Type: application/json' \\
  --data '{"type":"Add","target":"http://localhost:3000/alice/heart/123/"}'
~~~

The request only produces useful processing when the token and derived resource are available. GET /clearAuditLoggedQueryService is present in GETHandler, but HTTPServer does not initialize the query_registry passed to it, so this maintenance endpoint is not reliable on main. Other GET paths do not provide a working monitoring API or guaranteed static-page response.

## End-to-end heart/IBI example

The small heart/IBI example is split across:

- [docs/queries/rspql/heart_ibi_window.rq](docs/queries/rspql/heart_ibi_window.rq) monitors <http://localhost:3000/alice/heart/> with a 60-second range and step, selecting the maximum IBI value.
- [docs/rules/n3/anomaly_detection.n3](docs/rules/n3/anomaly_detection.n3) infers ex:alert "ALERT" when a measurement value is greater than 99.9.
- [docs/policies/example-heart-policy.ttl](docs/policies/example-heart-policy.ttl) shows ODRL permissions for Alice source/derived resources, PANDA, benchmark actors, the replayer, and a webhook channel. Some benchmark permissions use urn:client:benchmark.
- [docs/data/DATASETS.md](docs/data/DATASETS.md) is a dataset template with TODOs, not a downloadable canonical dataset.

The intended workflow is:

~~~text
heart/IBI observations in a Solid LDES
  -> UMA/ODRL-controlled source and derived-resource access
  -> RSP-QL window over the IBI property
  -> aggregation RDF event
  -> N3/EYE anomaly inference
  -> reasoned RDF over PANDA WebSocket
~~~

To run it, place an actual LDES at the query URL, ensure its policy authorizes the identity used by PANDA’s active UMA claim, configure required CSS credentials, and make the notification destination reachable. These files explain query, rule, and policy shapes; they do not provide the complete dataset, external UMA revision, or fully local notification deployment needed for reproduction.

## Logging and outputs

src/index.ts creates these files in the process working directory:

- aggregator-YYYY-MM-DD-HH-MM-SS.log: Bunyan output for PANDA’s structured log events.
- aggregator_resource_used-YYYY-MM-DD-HH-MM-SS.csv: samples every 500 ms from Node CPU and memory APIs. The header includes cpu_system, but the current row writer does not emit a separate system-CPU value; treat this as evaluation instrumentation with a schema caveat.

AuditLoggedQueryService also writes query_audit_log.json when a query is registered. Its path is computed from the compiled module’s __dirname, not configuration; with the normal dist layout it resolves above the PANDA project directory.

These are operational/audit or resource-instrumentation outputs. They are not the healthcare dataset. The current running path does not publish generated results into the configured aggregation-pod LDES: although a publisher listener exists, the generated-result path does not emit the event that would materialize results there, and the explicit publisher call in HTTPServer is commented out.

## Build, test, and lint

~~~bash
npm run build
npm test
npm run lint:ts
~~~

Additional package scripts include npm run test:watch, npm run lint:ts:fix, npm run lint:no-warning, and npm run docs. Several test files are empty or contain placeholder assertions; npm test should not be interpreted as comprehensive system or end-to-end coverage.

## Reproducing the paper evaluation

Detailed evaluation material remains in documentation and branch-specific artifacts:

- [docs/BRANCHES_AND_POLICIES.md](docs/BRANCHES_AND_POLICIES.md) maps branches to policy scenarios, protected resources, benchmark harnesses, and validation roles.
- [docs/SCENARIOS_AND_REPRODUCIBILITY.md](docs/SCENARIOS_AND_REPRODUCIBILITY.md) describes the heart/IBI scenario family, inputs, policies, expected authorization behavior, and naming inconsistencies.
- [docs/data/DATASETS.md](docs/data/DATASETS.md), [docs/queries/rspql/heart_ibi_window.rq](docs/queries/rspql/heart_ibi_window.rq), [docs/policies/example-heart-policy.ttl](docs/policies/example-heart-policy.ttl), and [docs/rules/n3/anomaly_detection.n3](docs/rules/n3/anomaly_detection.n3) provide the current data note and example artifacts.

Available branches include baseline-scenario, limited-access-caregiver-scenario, policy-based-denial, protected-alert, authorized-caregiver-alert-read-benchmark, policy-size-benchmark, concurrent-requests, and benchmark-cpu-memory, alongside feature and migration branches. main does not contain the benchmark directories used by those branches. A checkout of main alone does not reproduce every paper experiment; use the branch mapping and pin relevant PANDA, UMA, data, and RSP-JS revisions before citing results.

## Known limitations and research-prototype notes

- **Docker is not a working installation path on main.** Dockerfile runs npm install with the external file:../RSP/RSP-JS dependency unavailable in the Docker build context, exposes port 8080, and invokes npm run start-aggregation. No start-aggregation script exists in package.json. docker-compose.yaml only maps port 8080 and does not solve either issue.
- **The CLI Solid-server option is ineffective.** Commander creates options.solid_server_url, while the action reads options.SolidServer; the stored value is also not used by the active stream path.
- **Notification routing is partly hard-coded.** src/utils/notifications/Util.ts hard-codes a remote WebhookChannel2023 subscription server, while aggregator_setup.json contains a different remote PANDA HTTP destination. Local-only use requires code/configuration alignment.
- **Stream discovery is not active.** The server accepts stream URLs already present in the query. Type Index locator and discovery helpers do not prove automatic Pod-to-stream resolution on main.
- **Authorization setup is incomplete on main.** The active fetcher uses a fixed replayer claim, source credentials are exact URL-keyed JSON entries, and the local CSS script uses allow-all. Policy scenario branches add stronger UMA/ODRL setup and validation.
- **Rule handling is singleton-scoped.** The first WebSocket query initializes the reasoner’s rules; later query rule strings do not replace that singleton, and the historical WebID-rule fallback contains an assignment condition, so it is not a reliable fallback path.
- **The heart example is not self-contained.** Dataset documentation is a template, the compatible UMA revision is not pinned, and the example stream is not represented in the historical credential map in src/config/PodToken.json.
- **Result persistence is disabled.** The LDES publisher and aggregation-pod configuration remain in the tree, but the active WebSocket path sends results to clients and does not reliably materialize them into the aggregation pod.
- **Credential hygiene requires attention.** Tracked JSON files contain development/example account or token material. Treat them as non-production fixtures, rotate values used outside a disposable environment, and never add real credentials.
- **Repository metadata has a small inconsistency.** package.json declares ISC, while LICENCE.md contains MIT licence text. The licence file is the authoritative human-readable licence artifact.

## Research context

PANDA is maintained as a research prototype and research artifact. The repository does not currently contain a stable publication citation. Publication/citation information will be added here when the project provides one.

## Licence and contact

Copyright belongs to [Ghent University - imec IDLab](https://idlab.ugent.be/). See [LICENCE.md](LICENCE.md) for the repository’s licence text.

For questions, contact [Kush](mailto:mailkushbisen@gmail.com) or open an issue in the [PANDA issue tracker](https://github.com/SolidLabResearch/PANDA/issues).
