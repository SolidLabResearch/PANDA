function normalizeEnvBool(value: string | undefined): boolean {
    return typeof value === 'string' && value.toLowerCase() === 'true';
}

export function isBenchmarkControlEnabled(): boolean {
    return normalizeEnvBool(process.env.PANDA_BENCHMARK_CONTROL_ENABLED);
}

export function getBenchmarkControlToken(): string | undefined {
    const token = process.env.PANDA_BENCHMARK_CONTROL_TOKEN;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
}

export type BenchmarkControlAuthResult = {
    accepted: boolean;
    reason?: 'control_disabled' | 'token_not_configured' | 'token_missing' | 'token_mismatch';
};

export function authorizeBenchmarkControl(incomingToken?: string): BenchmarkControlAuthResult {
    if (!isBenchmarkControlEnabled()) {
        return { accepted: false, reason: 'control_disabled' };
    }
    const configuredToken = getBenchmarkControlToken();
    if (!configuredToken) {
        return { accepted: false, reason: 'token_not_configured' };
    }
    if (!incomingToken) {
        return { accepted: false, reason: 'token_missing' };
    }
    if (incomingToken !== configuredToken) {
        return { accepted: false, reason: 'token_mismatch' };
    }
    return { accepted: true };
}
