# Auth Cache Decision

## Chosen Model
Option A: intentional shared cache.

The replay path keeps a process-wide `TokenManagerService` singleton. All streams/fetchers share one token cache keyed by exact container URL.

Semantics are explicit:
- Same container URL key: token state is shared across stream instances.
- Different container URL keys: token state is isolated and never reused across keys.
- First write wins for a key during a run (`setAccessToken` keeps existing entries).

## Why This Is Correct
This model matches the existing replay behavior and avoids wider dependency-injection changes in the replay path.

Correctness guarantees after this patch:
- Partial orchestrator failures are structured (`ReplayPartialFailureError`) with `succeededCount`, `failedCount`, and per-stream failure details.
- Cache sharing behavior is now tested at the UMA fetcher level:
  - same-container fetchers reuse cached token,
  - different-container fetchers perform independent UMA flow.

This makes auth behavior deterministic and auditable without changing runtime topology.

## Benchmark Implications
The chosen model is benchmark-safe and low overhead:
- Shared per-container cache avoids repeated UMA grant flow for repeated posts to the same container, reducing authorization round-trips.
- URL-keyed isolation prevents accidental token reuse across containers, preserving correctness.
- No per-orchestrator token manager allocation or dependency threading is introduced, so runtime and memory behavior remain close to current baselines.
