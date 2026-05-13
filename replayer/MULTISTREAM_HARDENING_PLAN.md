# 1. Critical fixes to implement now

- Add a single-flight guard around `process_queue_once` so overlapping interval ticks cannot process queue items concurrently in the same `PublishObservations` instance.
- Add an explicit queue item invariant check before posting: each dequeued item must keep the configured stream/container pairing for that replayer, otherwise fail fast with a clear error.
- Clarify orchestrator partial-failure semantics in code by waiting for all streams to settle, then throwing a structured error if any fail (including success/failure counts and per-stream reasons), instead of fail-fast `Promise.all` behavior.

# 2. Architectural choice to make explicit

`TokenManagerService` should remain process-global for now, with an explicit follow-up decision point.

Tradeoff:
- Keep singleton (current): simple shared token cache and no constructor plumbing changes; lowest-risk patch for immediate correctness hardening.
- Inject/per-instance: stronger isolation and easier deterministic testing, but requires touching constructors/dependency wiring across fetcher/replayer setup and introduces broader refactor risk.

Given the goal is smallest correctness hardening without redesign, keep the singleton now and document that per-instance injection is the next isolation-oriented change if token cross-talk appears in production.

# 3. Minimal tests to add

- `PublishObservations`: test `process_queue_once` single-flight behavior by triggering concurrent calls and verifying only one fetch happens.
- `PublishObservations`: test queue invariant guard rejects when a queue item has mismatched `stream_location`/`container`.
- `ReplayOrchestrator`: test partial-failure semantics report (waits all streams, then throws error containing failed/succeeded counts).
