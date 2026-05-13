# Multi-Stream Refactor Verification

Date: 2026-04-20

## 1) Each `PublishObservations` instance has fully isolated replay state

- **Classification:** `likely`
- **Evidence (source):**
  - Constructor initializes per-instance mutable state (`store`, `stream_consumer`, `observation_pointer`, `sort_subject_length`, `number_of_post`, `queue`, `container_to_publish`) in [`src/publishing/PublishObservations.ts:33`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:33).
  - Replay flow reads/writes only `this.*` state (`initialize`, `publish_one_observation`, `process_queue_once`, `replay_observations`) in [`src/publishing/PublishObservations.ts:84`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:84), [`src/publishing/PublishObservations.ts:124`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:124), [`src/publishing/PublishObservations.ts:160`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:160), [`src/publishing/PublishObservations.ts:183`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:183).
  - Existing and added tests run multiple instances concurrently with isolated outputs in [`src/publishing/PublishObservations.test.ts:46`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.test.ts:46), [`src/publishing/PublishObservations.test.ts:329`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.test.ts:329).
- **Most important remaining risk:** token/auth cache is process-global singleton (`TokenManagerService.getInstance`) and therefore not fully instance-isolated in memory; it is keyed by container URL, so wrong key usage could still cross-affect streams ([`src/service/TokenManagerService.ts:10`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/service/TokenManagerService.ts:10), [`src/publishing/PublishObservations.ts:75`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:75)).

## 2) No queue item can be posted to the wrong stream target

- **Classification:** `likely`
- **Evidence (source):**
  - Queue item target is written from per-instance `container_to_publish` when enqueued in [`src/publishing/PublishObservations.ts:148`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:148).
  - Queue drain posts exactly to each dequeued item’s own `item.container` in [`src/publishing/PublishObservations.ts:164`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:164).
  - Tests assert file/location provenance separation in [`src/publishing/PublishObservations.test.ts:46`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.test.ts:46) and [`src/publishing/PublishObservations.test.ts:329`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.test.ts:329).
- **Most important remaining risk:** no runtime guard validates that `queue_item.stream_location` and `queue_item.container` remain a valid pair; a future refactor could mutate one without the other and pass tests only partially.

## 3) Completion logic is correct when multiple streams run concurrently

- **Classification:** `likely`
- **Evidence (source):**
  - Per-stream completion is `number_of_post >= sort_subject_length` in [`src/publishing/PublishObservations.ts:171`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:171).
  - Stream replay resolves only when complete + queue empty + producer exhausted in [`src/publishing/PublishObservations.ts:202`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:202).
  - Orchestrator waits all streams via `Promise.all` in [`src/publishing/ReplayOrchestrator.ts:25`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/ReplayOrchestrator.ts:25).
  - Added staggered completion test verifies streams finishing at different times still complete correctly in [`src/publishing/PublishObservations.test.ts:377`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.test.ts:377).
- **Most important remaining risk:** `process_queue_once` can overlap across interval ticks because it is async and not locked; this can produce timing-sensitive behavior under real latency/retries ([`src/publishing/PublishObservations.ts:192`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:192)).

## 4) One failing stream does not terminate or corrupt the others

- **Classification:** `needs runtime check`
- **Evidence (source):**
  - Failing stream rejection propagates through orchestrator `Promise.all`, so orchestrator call fails fast if any stream fails in [`src/publishing/ReplayOrchestrator.ts:25`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/ReplayOrchestrator.ts:25).
  - There is no explicit cross-stream cancellation in the orchestrator or shared queue state in `PublishObservations`.
  - Added test confirms that when one stream fails pre-auth, peers can still continue posting in [`src/publishing/PublishObservations.test.ts:226`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.test.ts:226).
- **Most important remaining risk:** orchestrator currently returns rejection for any single failure, which may be interpreted operationally as full replay failure even if other streams continue and succeed; no partial-result reporting exists.

## 5) The orchestrator does not accidentally serialize streams that are supposed to run in parallel

- **Classification:** `confirmed`
- **Evidence (source):**
  - Construction creates one replayer per stream immediately in [`src/publishing/ReplayOrchestrator.ts:9`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/ReplayOrchestrator.ts:9).
  - Replay dispatch is concurrent through `Promise.all(this.replayers.map(...))` in [`src/publishing/ReplayOrchestrator.ts:25`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/ReplayOrchestrator.ts:25).
  - Added test with one slow + two fast streams verifies elapsed wall time consistent with parallel execution in [`src/publishing/PublishObservations.test.ts:269`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.test.ts:269).
- **Most important remaining risk:** timer-based scheduling uses event-loop intervals per stream; heavy synchronous work (e.g., `appendFileSync`) can still reduce effective parallelism under load ([`src/publishing/PublishObservations.ts:290`](/Users/kushbisen/Code/PANDA Platform/policy-aware-decentralized-stream-replayer/src/publishing/PublishObservations.ts:290)).
