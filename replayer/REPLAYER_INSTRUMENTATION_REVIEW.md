# Replayer Instrumentation Review

This is a correction pass on `REPLAYER_BUG_AUDIT.md` and `REPLAYER_INSTRUMENTATION_PLAN.md`.

The main constraint is benchmark integrity: telemetry must not become part of the thing being measured. The plan currently assumes synchronous file logging, mixes producer-side and consumer-side signals, and uses a completion test that does not actually prove all work is finished.

## 1. Instrumentation mistakes that would distort benchmarks

- `REPLAYER_INSTRUMENTATION_PLAN.md` proposes `fs.appendFileSync(...)` in the hot path. That is benchmark-contaminating, not “low-friction.” It adds blocking disk I/O to enqueue, dequeue, and post code paths.
- The proposed JSONL logger is still synchronous in the example. The output format is fine, but the write mechanism is not. If telemetry must be on by default, it should be buffered or off-thread, or at minimum emitted only in a mode that is explicitly excluded from performance runs.
- The plan records several counts at the wrong side of the pipeline:
  - `enqueue_count` belongs on the producer side in `publish_one_observation()`, because that is where work enters the queue.
  - `dequeue_count` belongs on the consumer side in `process_queue()`, because that is where work leaves the queue.
  - `post_latency_ms` belongs in `post_with_retry()` on the consumer side, because queue wait and network latency are not visible on the producer side.
  - `token_cache_hit` / `token_cache_miss` belong in `ReuseTokenUMAFetcher.fetch()` or `TokenManagerService.getAccessToken()`, not in `PublishObservations`, because token reuse is a fetcher concern.
  - `auth_warmup_ms` belongs in `initialize()` / `authorizeFetch()`, not in replay timing, because it is startup overhead.
- `queue_depth` samples taken from both producer and consumer sides are useful, but only if they are cheap. Recording every enqueue and dequeue with disk writes will change queue behavior and inflate lag.
- The current completion condition in `publish_one_observation()`:
  - `this.number_of_post === this.sort_subject_length * this.containers_to_publish.length`
  - is not a safe replay-finished signal. It is only “all expected successful posts have been counted,” which can still miss in-flight work, retries, or future enqueues already scheduled by the producer timer.
- `appendFileSync('replayer-log.csv', ...)` in `post_with_retry()` is not telemetry-only. It is part of the measured POST path and will distort tail latency.
- The plan does not explicitly distinguish benchmark-relevant metrics from debugging metrics. Debug-only signals such as per-attempt request bodies, per-item logs, or verbose console traces should be excluded from benchmark runs.
- The plan treats `setInterval` cadence as if it were a neutral source of truth. It is not. Timer drift, overlap, and event-loop contention can all affect measured queue lag and completion time.

## 2. Metrics that are missing but necessary

- Queue wait time is missing.
  - This is the key missing metric for understanding backlog.
  - It should be measured as `dequeue_start_ts - enqueue_ts` for each item, or as close to that as possible.
  - Producer side should record the enqueue timestamp per item, and consumer side should compute lag when the item is actually dequeued or just before POST begins.
- Queue lag is missing as a first-class metric.
  - Depth alone does not show how stale queued work is.
  - Record both queue depth and oldest-item age.
- Time spent waiting for completion is missing.
  - The system needs a metric for “time from last enqueue to last successful post.”
  - That is separate from total replay duration.
- End-to-end completion needs a two-part state:
  - `producer_exhausted`
  - `queue_drained_and_all_posts_finished`
  - The current plan only covers the second part indirectly.
- Retry visibility is incomplete.
  - Record retry count and retry delay on the consumer side inside `post_with_retry()`.
  - Also record whether a post ultimately succeeded after retries or exhausted retries.
- In-flight work is missing.
  - If `process_queue()` can overlap, a plain queue depth metric is insufficient.
  - Track an `in_flight` count or a single-flight guard state so completion can prove that no POST is still pending.
- Producer cadence and consumer cadence are not clearly separated.
  - The plan mentions `frequency` and `frequency_buffer`, but the metrics should explicitly label producer-side emission rate and consumer-side drain rate so they are not misread later.
- Startup phase timing should be split more explicitly.
  - `dataset_load_ms`
  - `sort_ms`
  - `auth_warmup_ms`
  - These are all benchmark-distorting startup costs but they are not the same cost.

## 3. Exact places where completion detection should live

- The primary completion gate should live in `process_queue()`, after each successful or failed POST attempt has returned and after the queue state is checked again.
- `publish_one_observation()` should not declare completion based on `number_of_post`.
  - It is the producer.
  - It knows when new work was enqueued, not when all consumer work has finished.
  - It can only safely mark “producer finished enqueueing all expected items” if there is a separate producer-end condition.
- Completion should be split into two explicit signals:
  - Producer side: “all items enqueued.”
  - Consumer side: “all items confirmed complete.”
- If the code keeps the current timer model, the consumer-side completion check should require all of the following:
  - producer has finished enqueuing all expected items
  - `queue.length === 0`
  - no `process_queue()` call is in flight
  - all outstanding POSTs have either succeeded or exhausted retries
- The most conservative place to finalize completion is the consumer drain after the last successful POST, with a re-check that no new work was added during the drain.
- If the producer cannot naturally know it is finished without a pointer comparison, completion state should be stored as a separate boolean or counter, not inferred from `number_of_post`.
- Avoid putting completion logging in `main().then(...)` or any startup wrapper. That would report control flow completion, not replay completion.

## 4. Minimal safe telemetry patch plan

The least intrusive design is:

- keep telemetry out of the critical path
- keep metrics local to the component that owns the signal
- separate enqueue, dequeue, and completion state
- avoid synchronous file logging in hot paths

Recommended shape:

- Use an in-memory metrics buffer or a batched async sink.
- Emit only a small set of counters and timestamps needed for benchmark interpretation.
- Do not log full payloads, raw request bodies, or per-item verbose traces in benchmark mode.

### 5 smallest code edits to add useful telemetry without changing behavior

1. Add enqueue-side timestamps and queue-depth sampling in `publish_one_observation()`.
   - Record `enqueued_at` per queue item.
   - Update peak depth there.
   - This establishes producer-side queue arrival time.
2. Add dequeue-side queue wait measurement in `process_queue()`.
   - Compute `queue_wait_ms` from the stored enqueue timestamp before each POST.
   - Record queue depth after splice.
   - This gives the missing lag metric.
3. Add consumer-side retry and attempt counters in `post_with_retry()`.
   - Record attempt number, retry count, and final outcome.
   - Do not write the observation payload to telemetry.
4. Add explicit producer-finished state separate from success count.
   - Mark when the producer has enqueued the last expected item.
   - Use that flag for completion logic instead of `number_of_post`.
5. Add a completion check in `process_queue()` that fires only when producer-finished, queue-empty, and no in-flight work remain.
   - That is the earliest safe place to confirm replay completion without confusing enqueued work with completed work.

### 3 telemetry additions to avoid because they would contaminate results

1. `fs.appendFileSync(...)` or any other synchronous file write in the enqueue, dequeue, or POST hot path.
   - This directly inflates latency and queue lag.
2. Full payload logging or per-request body dumps.
   - The serialization and I/O overhead are large, and the data is not needed for benchmark interpretation.
3. High-frequency console logging inside timers or per-item loops.
   - Console output is slow, perturbs event-loop timing, and makes queue behavior look worse than it is.

### Recommendation on metric ownership

- Producer side:
  - enqueue count
  - enqueue timestamp
  - queue depth at enqueue
  - producer-finished flag
- Consumer side:
  - dequeue count
  - queue depth after dequeue
  - queue wait time
  - POST latency
  - retry count
  - confirmed completion
- Fetcher / auth side:
  - token cache hit/miss
  - auth warmup duration

