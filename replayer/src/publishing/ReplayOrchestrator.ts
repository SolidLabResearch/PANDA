import { ReplayConfig } from '../config/types';
import { PublishObservations } from './PublishObservations';

type ReplayerFactory = (config: ReplayConfig, streamIndex: number) => PublishObservations;

export interface ReplayStreamFailureDetail {
    streamIndex: number;
    reason: string;
}

export class ReplayPartialFailureError extends Error {
    public readonly succeededCount: number;
    public readonly failedCount: number;
    public readonly failures: ReplayStreamFailureDetail[];

    constructor(succeededCount: number, failedCount: number, failures: ReplayStreamFailureDetail[]) {
        const failureMessage = failures
            .map((failure) => `stream[${failure.streamIndex}]: ${failure.reason}`)
            .join('; ');
        super(`Replay partial failure: ${failedCount} failed, ${succeededCount} succeeded. ${failureMessage}`);
        this.name = 'ReplayPartialFailureError';
        this.succeededCount = succeededCount;
        this.failedCount = failedCount;
        this.failures = failures;
    }
}

export class ReplayOrchestrator {
    private readonly replayers: PublishObservations[];

    constructor(config: ReplayConfig, factory?: ReplayerFactory) {
        this.replayers = config.streams.map((stream, streamIndex) =>
            factory?.(config, streamIndex) ?? new PublishObservations(
                stream,
                config.frequency_event,
                config.frequency_buffer,
                config.is_ldes,
                config.tree_path
            )
        );
    }

    public getReplayers(): PublishObservations[] {
        return [...this.replayers];
    }

    public async replay_observations(): Promise<void> {
        const results = await Promise.allSettled(this.replayers.map((replayer) => replayer.replay_observations()));
        const failures = results
            .map((result, index) => ({ result, index }))
            .filter((entry): entry is { result: PromiseRejectedResult; index: number } => entry.result.status === 'rejected');

        if (failures.length > 0) {
            const succeededCount = results.length - failures.length;
            const failureDetails: ReplayStreamFailureDetail[] = failures.map((failure) => ({
                streamIndex: failure.index,
                reason: failure.result.reason instanceof Error
                    ? failure.result.reason.message
                    : String(failure.result.reason)
            }));
            throw new ReplayPartialFailureError(succeededCount, failures.length, failureDetails);
        }
    }
}
