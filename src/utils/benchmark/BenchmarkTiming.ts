export type BenchmarkUmaTiming = {
    resource?: string;
    claim_actor_webid?: string;
    used_stored_token?: boolean;
    used_cached_rpt?: boolean;
    uma_challenge_ms?: number;
    uma_token_exchange_ms?: number;
    uma_protected_get_ms?: number;
    total_uma_grant_ms?: number;
};

export type BenchmarkParsedWindowDefinition = {
    window_name: string;
    stream_name: string;
    width: number;
    slide: number;
};

export type BenchmarkTimingSnapshot = {
    correlation_id: string;
    benchmark_run_id?: string;
    requested_actor_webid?: string;
    registered_query?: string;
    parsed_rspql_windows?: BenchmarkParsedWindowDefinition[];
    rsp_window_parameter_unit?: string;
    server_received_at_ns?: string;
    query_registered_at_ns?: string;
    rsp_subscription_started_at_ns?: string;
    first_stream_event_at_ns?: string;
    first_stream_event_added_at_ns?: string;
    rsp_window_evaluated_at_ns?: string;
    first_result_emitted_at_ns?: string;
    rule_eval_started_at_ns?: string;
    rule_eval_finished_at_ns?: string;
    server_sent_at_ns?: string;
    uma?: BenchmarkUmaTiming;
    metrics?: BenchmarkServerMetrics;
};

export type BenchmarkServerMetrics = {
    rdf_parse_ms?: number;
    rdf_quads_parsed_count?: number;
    rsp_engine_construct_ms?: number;
    rsp_register_emitter_ms?: number;
    rsp_event_add_count_total?: number;
    rsp_event_add_count_after_query_registration?: number;
    rsp_event_add_total_ms?: number;
    rsp_event_add_mean_ms?: number;
    rsp_event_add_p95_ms?: number;
    rsp_stream_event_count_after_query_registration?: number;
    rsp_first_event_timestamp_ms?: number;
    rsp_last_event_timestamp_ms?: number;
    source_events_with_current_benchmark_run_id_count?: number;
    source_events_without_benchmark_run_id_count?: number;
    source_events_with_other_benchmark_run_id_count?: number;
    rsp_events_added_with_current_benchmark_run_id_count?: number;
    rsp_events_added_without_benchmark_run_id_count?: number;
    rsp_events_added_with_other_benchmark_run_id_count?: number;
    rsp_query_eval_ms?: number;
    first_result_emit_ms?: number;
};

export type BenchmarkTimingContext = {
    enabled: boolean;
    correlationId: string;
    benchmarkRunId?: string;
    serverTiming: BenchmarkTimingSnapshot;
    firstStreamEventRecorded: boolean;
    firstStreamEventAddedRecorded: boolean;
    firstWindowEvaluatedRecorded: boolean;
    firstResultEmittedRecorded: boolean;
    firstRuleEvalRecorded: boolean;
    firstServerSentRecorded: boolean;
    firstUmaRecorded: boolean;
    eventAddDurationsMs: number[];
    firstResultEmitStartedAtMs?: number;
};

type BenchmarkTimingNsKey =
    | 'server_received_at_ns'
    | 'query_registered_at_ns'
    | 'rsp_subscription_started_at_ns'
    | 'first_stream_event_at_ns'
    | 'first_stream_event_added_at_ns'
    | 'rsp_window_evaluated_at_ns'
    | 'first_result_emitted_at_ns'
    | 'rule_eval_started_at_ns'
    | 'rule_eval_finished_at_ns'
    | 'server_sent_at_ns';

export function isBenchmarkTimingEnabled(): boolean {
    return process.env.BENCHMARK_TIMING === '1';
}

export function nowNs(): bigint {
    return process.hrtime.bigint();
}

export function nsToString(value: bigint | undefined): string | undefined {
    return value === undefined ? undefined : value.toString();
}

export function durationMs(startNs: bigint, endNs: bigint): number {
    return Number(endNs - startNs) / 1_000_000;
}

export function createBenchmarkTimingContext(correlationId: string, benchmarkRunId?: string): BenchmarkTimingContext {
    return {
        enabled: isBenchmarkTimingEnabled(),
        correlationId,
        benchmarkRunId,
        serverTiming: {
            correlation_id: correlationId,
            benchmark_run_id: benchmarkRunId,
            metrics: {},
        },
        firstStreamEventRecorded: false,
        firstStreamEventAddedRecorded: false,
        firstWindowEvaluatedRecorded: false,
        firstResultEmittedRecorded: false,
        firstRuleEvalRecorded: false,
        firstServerSentRecorded: false,
        firstUmaRecorded: false,
        eventAddDurationsMs: [],
    };
}

export function maybeMarkBenchmarkNs(
    context: BenchmarkTimingContext | undefined,
    key: BenchmarkTimingNsKey,
    onlyFirst = false,
): void {
    if (!context?.enabled) {
        return;
    }
    if (onlyFirst && context.serverTiming[key] !== undefined) {
        return;
    }
    context.serverTiming[key] = nowNs().toString();
}

export function cloneBenchmarkTiming(
    context: BenchmarkTimingContext | undefined,
): BenchmarkTimingSnapshot | undefined {
    if (!context?.enabled) {
        return undefined;
    }
    return {
        ...context.serverTiming,
        parsed_rspql_windows: context.serverTiming.parsed_rspql_windows?.map((window) => ({ ...window })),
        uma: context.serverTiming.uma ? { ...context.serverTiming.uma } : undefined,
        metrics: context.serverTiming.metrics ? { ...context.serverTiming.metrics } : undefined,
    };
}

export function setBenchmarkQueryDetails(
    context: BenchmarkTimingContext | undefined,
    query: string,
    windows: BenchmarkParsedWindowDefinition[],
): void {
    if (!context?.enabled) {
        return;
    }
    context.serverTiming.registered_query = query;
    context.serverTiming.parsed_rspql_windows = windows.map((window) => ({ ...window }));
    context.serverTiming.rsp_window_parameter_unit = 'milliseconds';
}

export function addBenchmarkMetric(
    context: BenchmarkTimingContext | undefined,
    key: keyof BenchmarkServerMetrics,
    value: number,
): void {
    if (!context?.enabled || !Number.isFinite(value)) {
        return;
    }
    if (!context.serverTiming.metrics) {
        context.serverTiming.metrics = {};
    }
    context.serverTiming.metrics[key] = value;
}

export function incrementBenchmarkMetric(
    context: BenchmarkTimingContext | undefined,
    key: keyof BenchmarkServerMetrics,
    amount = 1,
): void {
    if (!context?.enabled || !Number.isFinite(amount)) {
        return;
    }
    if (!context.serverTiming.metrics) {
        context.serverTiming.metrics = {};
    }
    const current = context.serverTiming.metrics[key];
    context.serverTiming.metrics[key] = (typeof current === 'number' ? current : 0) + amount;
}

export function recordRspEventAddDuration(
    context: BenchmarkTimingContext | undefined,
    duration: number,
): void {
    if (!context?.enabled || !Number.isFinite(duration)) {
        return;
    }
    context.eventAddDurationsMs.push(duration);
    incrementBenchmarkMetric(context, 'rsp_event_add_count_total');
    incrementBenchmarkMetric(context, 'rsp_event_add_count_after_query_registration');
    incrementBenchmarkMetric(context, 'rsp_event_add_total_ms', duration);
    const total = context.serverTiming.metrics?.rsp_event_add_total_ms ?? 0;
    const count = context.serverTiming.metrics?.rsp_event_add_count_total ?? 0;
    if (count > 0) {
        addBenchmarkMetric(context, 'rsp_event_add_mean_ms', total / count);
        addBenchmarkMetric(context, 'rsp_event_add_p95_ms', percentile(context.eventAddDurationsMs, 95));
    }
}

export function recordRspStreamEventTimestamp(
    context: BenchmarkTimingContext | undefined,
    timestampMs: number,
): void {
    if (!context?.enabled || !Number.isFinite(timestampMs)) {
        return;
    }
    incrementBenchmarkMetric(context, 'rsp_stream_event_count_after_query_registration');
    if (context.serverTiming.metrics?.rsp_first_event_timestamp_ms === undefined) {
        addBenchmarkMetric(context, 'rsp_first_event_timestamp_ms', timestampMs);
    }
    addBenchmarkMetric(context, 'rsp_last_event_timestamp_ms', timestampMs);
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}
