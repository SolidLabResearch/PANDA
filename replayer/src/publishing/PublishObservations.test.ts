import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplayConfig } from '../config/types';
import { PublishObservations } from './PublishObservations';
import { ReplayOrchestrator, ReplayPartialFailureError } from './ReplayOrchestrator';

function createDatasetFile(dir: string, fileName: string, obsName: string): string {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(
        filePath,
        `<http://example.org/${obsName}> <https://saref.etsi.org/core/measurementMadeBy> <http://example.org/sensor-${obsName}> .\n` +
        `<http://example.org/${obsName}> <https://saref.etsi.org/core/hasTimestamp> "2024-01-01T00:00:00.000Z" .\n`,
    );
    return filePath;
}

function createDatasetFileWithObservations(dir: string, fileName: string, obsNames: string[]): string {
    const filePath = path.join(dir, fileName);
    const lines = obsNames.flatMap((obsName) => ([
        `<http://example.org/${obsName}> <https://saref.etsi.org/core/measurementMadeBy> <http://example.org/sensor-${obsName}> .`,
        `<http://example.org/${obsName}> <https://saref.etsi.org/core/hasTimestamp> "2024-01-01T00:00:00.000Z" .`
    ]));
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
    return filePath;
}

function createDatasetFromLines(dir: string, fileName: string, lines: string[]): string {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
    return filePath;
}

function createFetcher() {
    return {
        preAuthorize: jest.fn(async () => undefined),
        fetch: jest.fn(async () => ({ status: 201 })),
    };
}

describe('PublishObservations per-stream behavior', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayer-publish-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('routes observations from file A only to location A and file B only to location B', async () => {
        const fileA = createDatasetFile(tmpDir, 'a.nt', 'obs-a');
        const fileB = createDatasetFile(tmpDir, 'b.nt', 'obs-b');
        const fetcherA = createFetcher();
        const fetcherB = createFetcher();

        const replayerA = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-x/', file_location: fileA },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcherA }
        );
        const replayerB = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-y/', file_location: fileB },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcherB }
        );

        await Promise.all([replayerA.replay_observations(), replayerB.replay_observations()]);

        expect(fetcherA.fetch).toHaveBeenCalledTimes(1);
        const callA = (fetcherA.fetch as jest.Mock).mock.calls[0] as [string, { body: string }];
        expect(callA[0]).toBe('http://localhost:3000/alice/acc-x/');
        expect(callA[1].body).toContain('obs-a');
        expect(callA[1].body).not.toContain('obs-b');

        expect(fetcherB.fetch).toHaveBeenCalledTimes(1);
        const callB = (fetcherB.fetch as jest.Mock).mock.calls[0] as [string, { body: string }];
        expect(callB[0]).toBe('http://localhost:3000/alice/acc-y/');
        expect(callB[1].body).toContain('obs-b');
        expect(callB[1].body).not.toContain('obs-a');
    });

    test('LDES inbox resolution happens per configured stream target', async () => {
        const fileA = createDatasetFile(tmpDir, 'a.nt', 'obs-a');
        const fileB = createDatasetFile(tmpDir, 'b.nt', 'obs-b');
        const fetcherA = createFetcher();
        const fetcherB = createFetcher();
        const inboxResolverA = jest.fn(async () => 'http://localhost:3000/alice/acc-x/inbox/');
        const inboxResolverB = jest.fn(async () => 'http://localhost:3000/alice/acc-y/inbox/');

        const replayerA = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-x/', file_location: fileA },
            100,
            100,
            true,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcherA, inboxResolver: inboxResolverA }
        );
        const replayerB = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-y/', file_location: fileB },
            100,
            100,
            true,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcherB, inboxResolver: inboxResolverB }
        );

        await Promise.all([replayerA.replay_observations(), replayerB.replay_observations()]);

        expect(inboxResolverA).toHaveBeenCalledWith('http://localhost:3000/alice/acc-x/', 'https://saref.etsi.org/core/hasTimestamp');
        expect(inboxResolverB).toHaveBeenCalledWith('http://localhost:3000/alice/acc-y/', 'https://saref.etsi.org/core/hasTimestamp');
        const ldesCallA = (fetcherA.fetch as jest.Mock).mock.calls[0] as [string, unknown];
        const ldesCallB = (fetcherB.fetch as jest.Mock).mock.calls[0] as [string, unknown];
        expect(ldesCallA[0]).toBe('http://localhost:3000/alice/acc-x/inbox/');
        expect(ldesCallB[0]).toBe('http://localhost:3000/alice/acc-y/inbox/');
    });

    test('UMA preAuthorize and token reuse path are called per stream target', async () => {
        const fileA = createDatasetFile(tmpDir, 'a.nt', 'obs-a');
        const fetcher = createFetcher();
        const replayer = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-x/', file_location: fileA },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcher }
        );

        await replayer.replay_observations();

        expect(fetcher.preAuthorize).toHaveBeenCalledWith('http://localhost:3000/alice/acc-x/');
        expect(fetcher.fetch).toHaveBeenCalledWith(
            'http://localhost:3000/alice/acc-x/',
            expect.objectContaining({ method: 'POST' })
        );
    });

    test('invalid dataset path fails clearly at replay time', async () => {
        const fetcher = createFetcher();
        const replayer = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-x/', file_location: path.join(tmpDir, 'missing.nt') },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcher }
        );

        await expect(replayer.replay_observations()).rejects.toThrow(/Unable to read dataset/);
    });

    test('maps dcterms:issued to saref:hasTimestamp before publish', async () => {
        const file = createDatasetFromLines(tmpDir, 'issued-only.nt', [
            '<http://example.org/obs-issued> <https://saref.etsi.org/core/measurementMadeBy> <http://example.org/sensor-issued> .',
            '<http://example.org/obs-issued> <http://purl.org/dc/terms/issued> "2026-04-21T07:06:47.669Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .'
        ]);
        const fetcher = createFetcher();
        const replayer = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-x/', file_location: file },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcher }
        );

        await replayer.replay_observations();

        const call = (fetcher.fetch as jest.Mock).mock.calls[0] as [string, { body: string }];
        expect(call[1].body).toContain('<https://saref.etsi.org/core/hasTimestamp>');
        expect(call[1].body).not.toContain('<http://purl.org/dc/terms/issued>');
    });

    test('rejects invalid timestamp lexical form before replay starts', async () => {
        const file = createDatasetFromLines(tmpDir, 'invalid-ts.nt', [
            '<http://example.org/obs-invalid> <https://saref.etsi.org/core/measurementMadeBy> <http://example.org/sensor-invalid> .',
            '<http://example.org/obs-invalid> <https://saref.etsi.org/core/hasTimestamp> "2026-04-21T07:06:47.669NZ"^^<http://www.w3.org/2001/XMLSchema#dateTime> .'
        ]);
        const fetcher = createFetcher();
        const replayer = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-x/', file_location: file },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcher }
        );

        await expect(replayer.replay_observations()).rejects.toThrow(/timestamp must end with Z/);
        expect(fetcher.fetch).not.toHaveBeenCalled();
    });

    test('queue items retain stream/location ownership and completion works with multiple streams', async () => {
        const fileA = createDatasetFile(tmpDir, 'a.nt', 'obs-a');
        const fetcher = createFetcher();
        const replayer = new PublishObservations(
            { location: 'http://localhost:3000/alice/acc-x/', file_location: fileA },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcher }
        );

        await (replayer as any).initializePromise;
        await replayer.publish_one_observation();

        const queueSnapshot = replayer.getQueueSnapshot();
        expect(queueSnapshot).toHaveLength(1);
        expect(queueSnapshot[0].stream_location).toBe('http://localhost:3000/alice/acc-x/');
        expect(queueSnapshot[0].container).toBe('http://localhost:3000/alice/acc-x/');

        await replayer.process_queue_once();
        expect(replayer.isComplete()).toBe(true);
    });

    test('process_queue_once uses single-flight guard under concurrent calls', async () => {
        const fileA = createDatasetFile(tmpDir, 'single-flight.nt', 'obs-sf');
        const fetcher = {
            preAuthorize: jest.fn(async () => undefined),
            fetch: jest.fn(async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                return { status: 201 };
            }),
        };
        const replayer = new PublishObservations(
            { location: 'http://localhost:3000/alice/single-flight/', file_location: fileA },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcher }
        );

        await (replayer as any).initializePromise;
        await replayer.publish_one_observation();
        await Promise.all([replayer.process_queue_once(), replayer.process_queue_once()]);

        expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    });

    test('process_queue_once rejects queue item with mismatched stream/container pairing', async () => {
        const fileA = createDatasetFile(tmpDir, 'queue-invariant.nt', 'obs-inv');
        const fetcher = createFetcher();
        const replayer = new PublishObservations(
            { location: 'http://localhost:3000/alice/invariant/', file_location: fileA },
            100,
            100,
            false,
            'https://saref.etsi.org/core/hasTimestamp',
            { umaFetcher: fetcher }
        );

        await (replayer as any).initializePromise;
        (replayer as any).queue.push({
            stream_location: 'http://localhost:3000/alice/other-stream/',
            container: 'http://localhost:3000/alice/other-container/',
            data: '<http://example.org/a> <http://example.org/p> <http://example.org/o> .',
            headers: new Headers({ 'Content-Type': 'text/turtle' })
        });

        await expect(replayer.process_queue_once()).rejects.toThrow(/Queue item invariant violated/);
        expect(fetcher.fetch).not.toHaveBeenCalled();
    });
});

describe('ReplayOrchestrator integration', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayer-orchestrator-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('initializes and replays all configured streams independently', async () => {
        const files = [
            createDatasetFile(tmpDir, 'x.nt', 'obs-x'),
            createDatasetFile(tmpDir, 'y.nt', 'obs-y'),
            createDatasetFile(tmpDir, 'z.nt', 'obs-z')
        ];
        const fetchers = [createFetcher(), createFetcher(), createFetcher()];

        const config: ReplayConfig = {
            streams: [
                { location: 'http://localhost:3000/alice/acc-x/', file_location: files[0] },
                { location: 'http://localhost:3000/alice/acc-y/', file_location: files[1] },
                { location: 'http://localhost:3000/alice/acc-z/', file_location: files[2] }
            ],
            frequency_event: 100,
            frequency_buffer: 100,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        };

        const orchestrator = new ReplayOrchestrator(config, (cfg, index) => new PublishObservations(
            cfg.streams[index],
            cfg.frequency_event,
            cfg.frequency_buffer,
            cfg.is_ldes,
            cfg.tree_path,
            { umaFetcher: fetchers[index] }
        ));

        await orchestrator.replay_observations();

        expect(fetchers[0].fetch).toHaveBeenCalledWith('http://localhost:3000/alice/acc-x/', expect.any(Object));
        expect(fetchers[1].fetch).toHaveBeenCalledWith('http://localhost:3000/alice/acc-y/', expect.any(Object));
        expect(fetchers[2].fetch).toHaveBeenCalledWith('http://localhost:3000/alice/acc-z/', expect.any(Object));
    });

    test('one stream auth failure does not terminate other streams', async () => {
        const files = [
            createDatasetFile(tmpDir, 'ok-a.nt', 'obs-ok-a'),
            createDatasetFile(tmpDir, 'fail.nt', 'obs-fail'),
            createDatasetFile(tmpDir, 'ok-b.nt', 'obs-ok-b')
        ];
        const fetcherOkA = createFetcher();
        const fetcherFail = {
            preAuthorize: jest.fn(async () => { throw new Error('auth failed'); }),
            fetch: jest.fn(async () => ({ status: 201 })),
        };
        const fetcherOkB = createFetcher();
        const fetchers = [fetcherOkA, fetcherFail, fetcherOkB];

        const config: ReplayConfig = {
            streams: [
                { location: 'http://localhost:3000/alice/ok-a/', file_location: files[0] },
                { location: 'http://localhost:3000/alice/fail/', file_location: files[1] },
                { location: 'http://localhost:3000/alice/ok-b/', file_location: files[2] }
            ],
            frequency_event: 100,
            frequency_buffer: 100,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        };

        const orchestrator = new ReplayOrchestrator(config, (cfg, index) => new PublishObservations(
            cfg.streams[index],
            cfg.frequency_event,
            cfg.frequency_buffer,
            cfg.is_ldes,
            cfg.tree_path,
            { umaFetcher: fetchers[index] }
        ));

        let caught: unknown;
        try {
            await orchestrator.replay_observations();
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(ReplayPartialFailureError);
        const partialFailure = caught as ReplayPartialFailureError;
        expect(partialFailure.failedCount).toBe(1);
        expect(partialFailure.succeededCount).toBe(2);
        expect(partialFailure.failures).toEqual([
            expect.objectContaining({ streamIndex: 1, reason: 'auth failed' })
        ]);
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(fetcherOkA.fetch).toHaveBeenCalledTimes(1);
        expect(fetcherOkB.fetch).toHaveBeenCalledTimes(1);
        expect(fetcherFail.fetch).not.toHaveBeenCalled();
    });

    test('one slow stream and two fast streams are replayed in parallel', async () => {
        const files = [
            createDatasetFile(tmpDir, 'fast-a.nt', 'obs-fast-a'),
            createDatasetFile(tmpDir, 'slow.nt', 'obs-slow'),
            createDatasetFile(tmpDir, 'fast-b.nt', 'obs-fast-b')
        ];
        const fastFetcherA = {
            preAuthorize: jest.fn(async () => undefined),
            fetch: jest.fn(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { status: 201 };
            }),
        };
        const slowFetcher = {
            preAuthorize: jest.fn(async () => undefined),
            fetch: jest.fn(async () => {
                await new Promise((resolve) => setTimeout(resolve, 180));
                return { status: 201 };
            }),
        };
        const fastFetcherB = {
            preAuthorize: jest.fn(async () => undefined),
            fetch: jest.fn(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { status: 201 };
            }),
        };
        const fetchers = [fastFetcherA, slowFetcher, fastFetcherB];

        const config: ReplayConfig = {
            streams: [
                { location: 'http://localhost:3000/alice/fast-a/', file_location: files[0] },
                { location: 'http://localhost:3000/alice/slow/', file_location: files[1] },
                { location: 'http://localhost:3000/alice/fast-b/', file_location: files[2] }
            ],
            frequency_event: 1000,
            frequency_buffer: 1000,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        };

        const orchestrator = new ReplayOrchestrator(config, (cfg, index) => new PublishObservations(
            cfg.streams[index],
            cfg.frequency_event,
            cfg.frequency_buffer,
            cfg.is_ldes,
            cfg.tree_path,
            { umaFetcher: fetchers[index] }
        ));

        const start = Date.now();
        await orchestrator.replay_observations();
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(320);
        expect(slowFetcher.fetch).toHaveBeenCalledTimes(1);
        expect(fastFetcherA.fetch).toHaveBeenCalledTimes(1);
        expect(fastFetcherB.fetch).toHaveBeenCalledTimes(1);
    });

    test('payload provenance: file A payload never reaches location B', async () => {
        const fileA = createDatasetFile(tmpDir, 'a-prov.nt', 'obs-alpha');
        const fileB = createDatasetFile(tmpDir, 'b-prov.nt', 'obs-beta');
        const capturedPosts: Array<{ target: string; body: string }> = [];
        const captureFetcher = () => ({
            preAuthorize: jest.fn(async () => undefined),
            fetch: jest.fn(async (url: string, options: RequestInit) => {
                const body = typeof options.body === 'string' ? options.body : '';
                capturedPosts.push({ target: url, body });
                return { status: 201 };
            }),
        });
        const fetcherA = captureFetcher();
        const fetcherB = captureFetcher();

        const config: ReplayConfig = {
            streams: [
                { location: 'http://localhost:3000/alice/prov-a/', file_location: fileA },
                { location: 'http://localhost:3000/alice/prov-b/', file_location: fileB }
            ],
            frequency_event: 100,
            frequency_buffer: 100,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        };

        const orchestrator = new ReplayOrchestrator(config, (cfg, index) => new PublishObservations(
            cfg.streams[index],
            cfg.frequency_event,
            cfg.frequency_buffer,
            cfg.is_ldes,
            cfg.tree_path,
            { umaFetcher: index === 0 ? fetcherA : fetcherB }
        ));

        await orchestrator.replay_observations();

        const postsToA = capturedPosts.filter((post) => post.target === 'http://localhost:3000/alice/prov-a/');
        const postsToB = capturedPosts.filter((post) => post.target === 'http://localhost:3000/alice/prov-b/');

        expect(postsToA).toHaveLength(1);
        expect(postsToA[0].body).toContain('obs-alpha');
        expect(postsToA[0].body).not.toContain('obs-beta');

        expect(postsToB).toHaveLength(1);
        expect(postsToB[0].body).toContain('obs-beta');
        expect(postsToB[0].body).not.toContain('obs-alpha');
    });

    test('completion remains correct when streams finish at different times', async () => {
        const fileSlow = createDatasetFileWithObservations(tmpDir, 'slow-multi.nt', ['obs-slow-1', 'obs-slow-2']);
        const fileFast = createDatasetFile(tmpDir, 'fast-single.nt', 'obs-fast');

        const slowFetcher = {
            preAuthorize: jest.fn(async () => undefined),
            fetch: jest.fn(async () => {
                await new Promise((resolve) => setTimeout(resolve, 120));
                return { status: 201 };
            }),
        };
        const fastFetcher = {
            preAuthorize: jest.fn(async () => undefined),
            fetch: jest.fn(async () => ({ status: 201 })),
        };

        const config: ReplayConfig = {
            streams: [
                { location: 'http://localhost:3000/alice/slow-complete/', file_location: fileSlow },
                { location: 'http://localhost:3000/alice/fast-complete/', file_location: fileFast }
            ],
            frequency_event: 1000,
            frequency_buffer: 1000,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        };

        const orchestrator = new ReplayOrchestrator(config, (cfg, index) => new PublishObservations(
            cfg.streams[index],
            cfg.frequency_event,
            cfg.frequency_buffer,
            cfg.is_ldes,
            cfg.tree_path,
            { umaFetcher: index === 0 ? slowFetcher : fastFetcher }
        ));

        await orchestrator.replay_observations();

        const [slowReplayer, fastReplayer] = orchestrator.getReplayers();
        expect(slowReplayer.isComplete()).toBe(true);
        expect(fastReplayer.isComplete()).toBe(true);
        expect(slowFetcher.fetch).toHaveBeenCalledTimes(2);
        expect(fastFetcher.fetch).toHaveBeenCalledTimes(1);
    });

    test('partial failure semantics report succeeded and failed stream counts', async () => {
        const files = [
            createDatasetFile(tmpDir, 'ok-sem-a.nt', 'obs-ok-sem-a'),
            createDatasetFile(tmpDir, 'fail-sem.nt', 'obs-fail-sem'),
            createDatasetFile(tmpDir, 'ok-sem-b.nt', 'obs-ok-sem-b')
        ];
        const fetcherOkA = createFetcher();
        const fetcherFail = {
            preAuthorize: jest.fn(async () => { throw new Error('semantic auth failure'); }),
            fetch: jest.fn(async () => ({ status: 201 })),
        };
        const fetcherOkB = createFetcher();
        const fetchers = [fetcherOkA, fetcherFail, fetcherOkB];

        const config: ReplayConfig = {
            streams: [
                { location: 'http://localhost:3000/alice/ok-sem-a/', file_location: files[0] },
                { location: 'http://localhost:3000/alice/fail-sem/', file_location: files[1] },
                { location: 'http://localhost:3000/alice/ok-sem-b/', file_location: files[2] }
            ],
            frequency_event: 100,
            frequency_buffer: 100,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        };

        const orchestrator = new ReplayOrchestrator(config, (cfg, index) => new PublishObservations(
            cfg.streams[index],
            cfg.frequency_event,
            cfg.frequency_buffer,
            cfg.is_ldes,
            cfg.tree_path,
            { umaFetcher: fetchers[index] }
        ));

        let caught: unknown;
        try {
            await orchestrator.replay_observations();
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(ReplayPartialFailureError);
        const partialFailure = caught as ReplayPartialFailureError;
        expect(partialFailure.failedCount).toBe(1);
        expect(partialFailure.succeededCount).toBe(2);
        expect(partialFailure.failures).toEqual([
            expect.objectContaining({ streamIndex: 1, reason: 'semantic auth failure' })
        ]);
        expect(fetcherOkA.fetch).toHaveBeenCalledTimes(1);
        expect(fetcherOkB.fetch).toHaveBeenCalledTimes(1);
    });
});
