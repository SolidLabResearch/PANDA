# Replayer Instrumentation Plan

Goal: add low-friction telemetry for replay benchmarking without changing the replay semantics.

## Metric Schema

Use a single helper in `src/publishing/PublishObservations.ts` so the metrics stay consistent.

Suggested fields for each event:

- `metric`
- `value`
- `ts`
- `run_id`
- `container`
- `observation_id`
- `queue_depth`
- `attempt`

Suggested helper variables to add to `PublishObservations`:

- `private run_id: string`
- `private metrics_log_path: string`
- `private queue_depth_samples: Array<{ ts: number; depth: number }>`
- `private queue_depth_peak: number`
- `private enqueue_count: number`
- `private dequeue_count: number`
- `private post_retry_count: number`
- `private token_cache_hit_count: number`
- `private token_cache_miss_count: number`
- `private auth_warmup_started_at: number`
- `private auth_warmup_finished_at: number`
- `private replay_started_at: number`
- `private replay_finished_at: number | null`

Add a small logger method:

```ts
private recordMetric(metric: string, value: number | string, extra: Record<string, unknown> = {}) {
    fs.appendFileSync(this.metrics_log_path, JSON.stringify({
        ts: Date.now(),
        run_id: this.run_id,
        metric,
        value,
        ...extra,
    }) + '\n');
}
```

## 1. Dataset load time

Exact location:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `load_dataset()`

Add:

- `const dataset_load_started_at = Date.now();`
- `this.recordMetric('dataset_load_start', dataset_load_started_at);`
- in the `stream_parser.on('end', ...)` handler:
  - `const dataset_load_finished_at = Date.now();`
  - `this.recordMetric('dataset_load_ms', dataset_load_finished_at - dataset_load_started_at, { file_location });`

Exact variables:

- local: `dataset_load_started_at`
- class-level optional: `private dataset_load_ms: number`

## 2. Sort time

Exact location:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `sort_observations()`

Add:

- `const sort_started_at = Date.now();`
- before `return sorted_observation_subjects;`:
  - `const sort_finished_at = Date.now();`
  - `this.recordMetric('sort_ms', sort_finished_at - sort_started_at, { subjects: sorted_observation_subjects.length });`

If you want to separate sort phases, also instrument:

- `merge_sort()` with `merge_sort_calls`
- `merge()` with `merge_comparisons`

Suggested counters:

- `private merge_sort_calls = 0`
- `private merge_comparisons = 0`

## 3. Queue depth over time

Exact locations:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `publish_one_observation()`
- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `process_queue()`
- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `replay_observations()`

Add queue-depth samples at these points:

- after each `this.queue.push(queue_object)`:
  - `this.queue_depth_peak = Math.max(this.queue_depth_peak, this.queue.length);`
  - `this.recordMetric('queue_depth', this.queue.length, { phase: 'enqueue', container });`
- right after `const items_to_publish = this.queue.splice(...)`:
  - `this.recordMetric('queue_depth', this.queue.length, { phase: 'dequeue', batch_size: items_to_publish.length });`
- on a fixed cadence inside the queue-drain interval:
  - `this.recordMetric('queue_depth', this.queue.length, { phase: 'sample' });`

Exact variable:

- `this.queue_depth_peak`

## 4. Enqueue rate

Exact location:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `publish_one_observation()`

Add:

- `this.enqueue_count += this.containers_to_publish.length;`
- `this.recordMetric('enqueue_count', this.enqueue_count, { observation_pointer: this.observation_pointer });`
- `this.recordMetric('enqueue_batch_size', this.containers_to_publish.length, { observation_pointer: this.observation_pointer });`

If you want rate instead of count, compute:

- `enqueue_rate = enqueue_count / elapsed_seconds_since_replay_started`

Suggested variables:

- `private enqueue_window_started_at = Date.now()`
- `private enqueue_window_count = 0`

## 5. Dequeue rate

Exact location:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `process_queue()`

Add:

- after `items_to_publish` is computed:
  - `this.dequeue_count += items_to_publish.length;`
  - `this.recordMetric('dequeue_count', this.dequeue_count, { batch_size: items_to_publish.length });`
- inside the loop, after each successful or failed `post_with_retry()` call:
  - `this.recordMetric('dequeue_item_processed', 1, { container: item.container });`

Suggested variables:

- `private dequeue_window_started_at = Date.now()`
- `private dequeue_window_count = 0`

## 6. POST latency

Exact location:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `post_with_retry()`

Add around each fetch attempt:

- `const post_started_at = Date.now();`
- immediately before `await this.uma_fetcher.fetch(...)`
- after response is received:
  - `const post_finished_at = Date.now();`
  - `this.recordMetric('post_latency_ms', post_finished_at - post_started_at, { container, attempt, status: response.status });`

For successful posts, also record:

- `this.recordMetric('post_success', 1, { container, attempt, status: response.status });`

For failures:

- `this.recordMetric('post_failure', 1, { container, attempt, error: String(error) });`

## 7. Retry count

Exact location:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `post_with_retry()`

Add:

- on every `catch` path except the terminal failure:
  - `this.post_retry_count += 1;`
  - `this.recordMetric('post_retry', 1, { container, attempt, delay });`
- on the final failure path:
  - `this.recordMetric('post_retry_exhausted', 1, { container, retries });`

Suggested variable:

- `private post_retry_count = 0`

## 8. Token cache hit/miss

Exact location:

- [`src/fetcher/ReuseTokenUMAFetcher.ts`](./src/fetcher/ReuseTokenUMAFetcher.ts) / `fetch()`
- [`src/service/TokenManagerService.ts`](./src/service/TokenManagerService.ts) / `getAccessToken()`

Add in `fetch()` immediately after `const tokenInfo = ...`:

- if `tokenInfo.access_token && tokenInfo.token_type`:
  - `this.recordMetric('token_cache_hit', 1, { url });`
- else:
  - `this.recordMetric('token_cache_miss', 1, { url });`

If you do not want to couple telemetry to the fetcher, add:

- `public getAccessToken(containerUrl: string): { ..., cacheHit: boolean }`

Suggested counters:

- `private token_cache_hit_count = 0`
- `private token_cache_miss_count = 0`

## 9. Auth warmup time

Exact location:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `initialize()`
- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `authorizeFetch()`

Add:

- in `initialize()` before `await this.authorizeFetch(...)`:
  - `this.auth_warmup_started_at = Date.now();`
  - `this.recordMetric('auth_warmup_start', this.auth_warmup_started_at, { containers: this.ldes_locations.length });`
- after `await this.authorizeFetch(...)`:
  - `this.auth_warmup_finished_at = Date.now();`
  - `this.recordMetric('auth_warmup_ms', this.auth_warmup_finished_at - this.auth_warmup_started_at, { containers: this.ldes_locations.length });`

If you want per-container warmup:

- instrument `ReuseTokenUMAFetcher.preAuthorize(resource)` with:
  - `preauth_started_at`
  - `preauth_finished_at`
  - `preauth_ms`

## 10. End-to-end replay completion time

Exact location:

- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `replay_observations()`
- [`src/publishing/PublishObservations.ts`](./src/publishing/PublishObservations.ts) / `publish_one_observation()`

Add:

- in `replay_observations()` after initialization and before timer setup:
  - `this.replay_started_at = Date.now();`
  - `this.recordMetric('replay_start', this.replay_started_at);`
- in `publish_one_observation()` when the final post has completed:
  - `this.replay_finished_at = Date.now();`
  - `this.recordMetric('replay_complete_ms', this.replay_finished_at - this.replay_started_at, { total_posts: this.number_of_post });`

Guard condition to use:

- when `this.number_of_post === this.sort_subject_length * this.containers_to_publish.length`

## Implementation order

1. Add the shared metric logger and run identifiers.
2. Add dataset load and sort timing.
3. Add queue depth and enqueue/dequeue counters.
4. Add POST latency and retry telemetry.
5. Add token cache hit/miss and auth warmup timing.
6. Add end-to-end completion timing.

## Output format recommendation

Write metrics as one JSON object per line to a dedicated file, for example `replayer-metrics.jsonl`, to avoid mixing them with the existing CSV log.
