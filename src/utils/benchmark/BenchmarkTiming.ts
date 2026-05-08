export type BenchmarkUmaTiming = {
    resource?: string;
    used_stored_token?: boolean;
    used_cached_rpt?: boolean;
    uma_challenge_ms?: number;
    uma_token_exchange_ms?: number;
    uma_protected_get_ms?: number;
    total_uma_grant_ms?: number;
};

export type BenchmarkTimingSnapshot = {
    correlation_id: string;
    server_received_at_ns?: string;
    query_registered_at_ns?: string;
    rsp_subscription_started_at_ns?: string;
    first_stream_event_at_ns?: string;
    rsp_window_evaluated_at_ns?: string;
    rule_eval_started_at_ns?: string;
    rule_eval_finished_at_ns?: string;
    server_sent_at_ns?: string;
    uma?: BenchmarkUmaTiming;
};

export type BenchmarkTimingContext = {
    enabled: boolean;
    correlationId: string;
    serverTiming: BenchmarkTimingSnapshot;
    firstStreamEventRecorded: boolean;
    firstWindowEvaluatedRecorded: boolean;
    firstRuleEvalRecorded: boolean;
    firstServerSentRecorded: boolean;
    firstUmaRecorded: boolean;
};

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

export function createBenchmarkTimingContext(correlationId: string): BenchmarkTimingContext {
    return {
        enabled: isBenchmarkTimingEnabled(),
        correlationId,
        serverTiming: {
            correlation_id: correlationId,
        },
        firstStreamEventRecorded: false,
        firstWindowEvaluatedRecorded: false,
        firstRuleEvalRecorded: false,
        firstServerSentRecorded: false,
        firstUmaRecorded: false,
    };
}

export function maybeMarkBenchmarkNs(
    context: BenchmarkTimingContext | undefined,
    key: keyof Omit<BenchmarkTimingSnapshot, 'correlation_id' | 'uma'>,
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
        uma: context.serverTiming.uma ? { ...context.serverTiming.uma } : undefined,
    };
}
