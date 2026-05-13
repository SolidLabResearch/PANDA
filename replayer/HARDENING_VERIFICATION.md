# Hardening Patch Verification

Date: 2026-04-20

Scope: Final focused pass on four checks only.

## 1) isProcessingQueue reset behavior

Status: confirmed

Evidence:
- Guard flag is set before dequeue/post processing in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L168).
- Reset is in a finally path in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L176), with explicit reset in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L177).
- The wrapped body includes both invariant validation and post path in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L174) and [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L175), so thrown invariant errors and rejected post attempts both flow through finally.
- Rejected queue processing is surfaced by caller catch in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L203), but the lock reset already occurred in finally.

Conclusion:
- Reset is correctly guaranteed on success and on failure paths, including thrown errors and post retry exhaustion.

## 2) Partial failure error shape stability and testability

Status: partially confirmed

Exact thrown structure from orchestrator:
- The orchestrator throws a plain Error instance in [src/publishing/ReplayOrchestrator.ts](src/publishing/ReplayOrchestrator.ts#L41).
- Error message format is constructed as:
  Replay partial failure: <failedCount> failed, <succeededCount> succeeded. stream[<index>]: <reason>; ...
  See [src/publishing/ReplayOrchestrator.ts](src/publishing/ReplayOrchestrator.ts#L42).
- Shape is therefore:
  - type: Error
  - name: Error
  - message: deterministic string prefix plus per-stream details
  - stack: runtime-generated
  - custom fields: none

Test coverage of important fields:
- Partial failure count fields are asserted in [src/publishing/PublishObservations.test.ts](src/publishing/PublishObservations.test.ts#L507).
- Peer success continuation is asserted in [src/publishing/PublishObservations.test.ts](src/publishing/PublishObservations.test.ts#L508) and [src/publishing/PublishObservations.test.ts](src/publishing/PublishObservations.test.ts#L509).
- Related failure-propagation behavior is asserted by auth-failure case in [src/publishing/PublishObservations.test.ts](src/publishing/PublishObservations.test.ts#L267).

Gap:
- Tests do not currently assert stream index and reason formatting inside failureDetails, only the aggregate count message and side effects.

## 3) Queue invariant false-positive risk in current design

Status: confirmed unlikely in current architecture

Evidence against false positives:
- Queue is per-instance mutable state on each replayer in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L50).
- Queue item fields are populated from the same instance-owned routing pair at enqueue time in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L151) and [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L152).
- Invariant compares queue item values to that same instance routing pair in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L320).
- Normal replay initializes container once before replay loop in [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L85) and [src/publishing/PublishObservations.ts](src/publishing/PublishObservations.ts#L89), then uses it consistently.
- Concurrency guard test and invariant rejection test pass: [src/publishing/PublishObservations.test.ts](src/publishing/PublishObservations.test.ts#L178), [src/publishing/PublishObservations.test.ts](src/publishing/PublishObservations.test.ts#L203), [src/publishing/PublishObservations.test.ts](src/publishing/PublishObservations.test.ts#L223).

Conclusion:
- In the current per-instance routing model, the invariant should only fire on actual state corruption/manual mutation, not under expected flow.

## 4) Remaining highest-risk unresolved issue: TokenManagerService shared state

Status: unresolved, highest risk remains here

Focused analysis:
- Token cache is process-global singleton in [src/service/TokenManagerService.ts](src/service/TokenManagerService.ts#L10).
- Shared mutable map is keyed only by container URL in [src/service/TokenManagerService.ts](src/service/TokenManagerService.ts#L4) and [src/service/TokenManagerService.ts](src/service/TokenManagerService.ts#L21).
- Write-once policy refuses updates for an existing key in [src/service/TokenManagerService.ts](src/service/TokenManagerService.ts#L37) and [src/service/TokenManagerService.ts](src/service/TokenManagerService.ts#L40).
- Fetcher reads and writes this shared cache by URL in [src/fetcher/ReuseTokenUMAFetcher.ts](src/fetcher/ReuseTokenUMAFetcher.ts#L24) and [src/fetcher/ReuseTokenUMAFetcher.ts](src/fetcher/ReuseTokenUMAFetcher.ts#L111).

Why this is still high risk in multi-stream operation:
- If two streams target the same container URL with different effective auth context over time, first-writer-wins can leave stale/incorrect token reuse.
- No TTL/refresh/overwrite policy exists, so a once-valid token can remain pinned until process end or explicit clear.
- Any call to clear operation affects shared process state and can impact peer streams.

Impact:
- Potential non-deterministic authorization outcomes under long or mixed benchmark runs, especially with shared targets or token expiry dynamics.

## Benchmark-readiness decision

Decision: still needs one more correctness patch before benchmarking.

Reason:
- Hardening patch goals for queue lock reset, failure aggregation, and routing invariant are in good shape.
- The remaining shared TokenManagerService semantics are still the highest correctness risk for reliable multi-stream benchmark behavior and result trustworthiness.

## Runtime check performed

Focused suite run result:
- Command run: npx jest src/publishing/PublishObservations.test.ts --runInBand --verbose
- Result: 1 suite passed, 13 tests passed, 0 failed
- Key checks passed: single-flight guard, invariant rejection, partial failure semantics
