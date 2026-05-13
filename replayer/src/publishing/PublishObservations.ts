import { LDESinLDP, LDPCommunication, storeToString } from '@treecg/versionawareldesinldp';
import * as fs from 'fs';
const N3 = require('n3');
import axios from 'axios';
import { StreamConsumer } from './StreamConsumer';
import { TokenManagerService } from '../service/TokenManagerService';
import { ReuseTokenUMAFetcher } from '../fetcher/ReuseTokenUMAFetcher';
import { StreamConfig } from '../config/types';
const { DataFactory } = N3;
const { namedNode, literal } = DataFactory;
const parser = new N3.Parser();
const SAREF_HAS_TIMESTAMP = 'https://saref.etsi.org/core/hasTimestamp';
const DCTERMS_ISSUED = 'http://purl.org/dc/terms/issued';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const DEFAULT_CLAIM_TOKEN = 'http://localhost:3000/alice/profile/card#me';
const DEFAULT_CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';

interface QueueItem {
    stream_location: string;
    container: string;
    data: string;
    headers: Headers;
}

interface FetcherLike {
    fetch: (url: string, options: RequestInit) => Promise<{ status: number; headers?: { get(name: string): string | null } }>;
    preAuthorize: (url: string) => Promise<unknown>;
}

interface PublishObservationsDependencies {
    umaFetcher?: FetcherLike;
    inboxResolver?: (ldesLocation: string, treePath: string) => Promise<string>;
}

/**
 * Handles replay for a single stream (one location + one source file).
 */
export class PublishObservations {
    public readonly stream: StreamConfig;
    public readonly file_location: string;
    public readonly uma_fetcher: FetcherLike;
    public readonly frequency: number;
    public readonly frequency_buffer: number;
    private readonly token_manager_service: TokenManagerService;
    private readonly communication: LDPCommunication;
    private readonly store: any;
    private readonly stream_consumer: StreamConsumer;
    private readonly tree_path: string;
    private readonly is_ldes: boolean;
    private readonly initializePromise: Promise<void>;
    private readonly inboxResolver: (ldesLocation: string, treePath: string) => Promise<string>;
    private container_to_publish: string;
    private sort_subject_length: number;
    private observation_pointer: number;
    private number_of_post: number;
    private queue: QueueItem[] = [];
    private sorted_observation_subjects!: string[];
    private isProcessingQueue: boolean = false;

    constructor(
        stream: StreamConfig,
        frequency: number,
        frequency_buffer: number,
        is_ldes: boolean,
        tree_path: string,
        dependencies?: PublishObservationsDependencies
    ) {
        this.stream = stream;
        this.file_location = stream.file_location;
        this.frequency = frequency;
        this.frequency_buffer = frequency_buffer;
        this.is_ldes = is_ldes;
        this.tree_path = tree_path;
        this.store = new N3.Store();
        this.stream_consumer = new StreamConsumer(this.store);
        this.observation_pointer = 0;
        this.sort_subject_length = 0;
        this.number_of_post = 0;
        this.container_to_publish = stream.location;
        this.communication = new LDPCommunication();
        this.token_manager_service = TokenManagerService.getInstance();
        this.uma_fetcher = dependencies?.umaFetcher ?? new ReuseTokenUMAFetcher({
            token: process.env.REPLAYER_UMA_CLAIM_TOKEN || DEFAULT_CLAIM_TOKEN,
            token_format: process.env.REPLAYER_UMA_CLAIM_TOKEN_FORMAT || DEFAULT_CLAIM_TOKEN_FORMAT
        });
        this.inboxResolver = dependencies?.inboxResolver ?? this.resolveLdesInbox.bind(this);
        this.initializePromise = this.initialize();
    }

    public async initialize() {
        await this.authorizeFetch(this.stream.location);
        await this.load_dataset(this.file_location);
        this.normalizeAndValidateDataset();

        if (this.is_ldes) {
            this.container_to_publish = await this.inboxResolver(this.stream.location, this.tree_path);
        } else {
            this.container_to_publish = this.stream.location;
        }

        this.sorted_observation_subjects = await this.sort_observations(this.store);
    }

    async load_dataset(file_location: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const stream_parser = new N3.StreamParser();
            const rdf_stream = fs.createReadStream(file_location);
            rdf_stream.pipe(stream_parser);
            stream_parser.pipe(this.stream_consumer.get_writer());
            rdf_stream.on('error', (error) => reject(new Error(`Unable to read dataset at "${file_location}": ${error.message}`)));
            stream_parser.on('error', (error: Error) => reject(new Error(`Unable to parse dataset at "${file_location}": ${error.message}`)));
            stream_parser.on('end', () => resolve());
        });
    }

    async sort_observations(store: any) {
        const temporary_array = [];
        for (const quad of store.match(null, 'https://saref.etsi.org/core/measurementMadeBy', null)) {
            temporary_array.push(quad.subject.id);
        }
        const sorted_observation_array = this.merge_sort(temporary_array, store);
        const reversed_sorted_observation_array = sorted_observation_array.reverse();
        const sorted_observation_subjects = new Array<string>();
        reversed_sorted_observation_array.forEach((quad) => {
            sorted_observation_subjects.push(quad);
        });
        this.sort_subject_length = sorted_observation_subjects.length;
        return sorted_observation_subjects;
    }

    async publish_one_observation() {
        if (this.observation_pointer >= this.sort_subject_length) {
            return;
        }

        const currentSubject = this.sorted_observation_subjects[this.observation_pointer];
        if (!currentSubject) {
            return;
        }

        const observation = JSON.stringify(currentSubject);
        const observation_object = JSON.parse(observation);
        this.store.removeQuads(this.store.getQuads(namedNode(observation_object), namedNode(SAREF_HAS_TIMESTAMP), null, null));
        const time_now = new Date().toISOString();
        this.store.addQuad(namedNode(observation_object), namedNode(SAREF_HAS_TIMESTAMP), literal(time_now, namedNode(XSD_DATETIME)));
        const store_observation = new N3.Store(this.store.getQuads(namedNode(observation_object), null, null, null));
        const store_observation_string = storeToString(store_observation);
        this.validateObservationPayload(store_observation_string, observation_object);

        if (store_observation_string) {
            const headers: Headers = new Headers({
                timeout: '10000',
                'Content-Type': 'text/turtle',
                'Authorization': `Bearer ${this.token_manager_service.getAccessToken(this.container_to_publish).access_token ?? ''}`,
            });
            const queue_object: QueueItem = {
                stream_location: this.stream.location,
                container: this.container_to_publish,
                data: store_observation_string,
                headers
            };
            this.queue.push(queue_object);
        }

        this.observation_pointer++;
    }

    public async process_queue_once() {
        if (this.isProcessingQueue) {
            return;
        }
        if (this.queue.length === 0) {
            return;
        }
        this.isProcessingQueue = true;
        try {
            const item = this.queue.shift();
            if (!item) {
                return;
            }
            this.assertQueueItemInvariant(item);
            await this.post_with_retry(item.container, item.data, item.headers, 3, 1000);
        } finally {
            this.isProcessingQueue = false;
        }
    }

    public isComplete(): boolean {
        return this.number_of_post >= this.sort_subject_length;
    }

    public getQueueSnapshot(): QueueItem[] {
        return [...this.queue];
    }

    public getContainerToPublish(): string {
        return this.container_to_publish;
    }

    async replay_observations() {
        await this.initializePromise;

        if (this.sort_subject_length === 0) {
            return;
        }

        const benchmarkRunId = process.env.BENCHMARK_RUN_ID || 'unknown';
        console.log(`[BENCHMARK_REPLAYER] started benchmark_run_id=${benchmarkRunId} stream=${this.stream.location} container=${this.container_to_publish} total_events=${this.sort_subject_length}`);

        return new Promise<void>((resolve, reject) => {
            let producerError: Error | null = null;
            const processInterval = setInterval(() => {
                this.process_queue_once().catch((error) => {
                    producerError = error as Error;
                });
                if (producerError) {
                    clearInterval(processInterval);
                    clearInterval(produceInterval);
                    reject(producerError);
                    return;
                }
                if (this.isComplete() && this.queue.length === 0 && this.observation_pointer >= this.sort_subject_length) {
                    clearInterval(processInterval);
                    clearInterval(produceInterval);
                    console.log(`[BENCHMARK_REPLAYER] completed benchmark_run_id=${benchmarkRunId} stream=${this.stream.location} total_events=${this.number_of_post}`);
                    resolve();
                }
            }, 1000 / this.frequency);

            const produceInterval = setInterval(() => {
                this.publish_one_observation().catch((error) => {
                    producerError = error as Error;
                });
            }, 1000 / this.frequency_buffer);
        });
    }

    merge_sort(array: string[], store: any): string[] {
        if (array.length <= 1) {
            return array;
        }

        const middle = Math.floor(array.length / 2);
        const left: string[] = this.merge_sort(array.slice(0, middle), store);
        const right: string[] = this.merge_sort(array.slice(middle), store);
        return this.merge(left, right, store);
    }

    merge(array_one: string[], array_two: string[], store: any): string[] {
        const merged: string[] = [];
        let i: number = 0;
        let j: number = 0;

        while (i < array_one.length && j < array_two.length) {
            const timestamp_one = store.getObjects(namedNode(array_one[i]).id, namedNode(SAREF_HAS_TIMESTAMP, null));
            const timestamp_two = store.getObjects(namedNode(array_two[j]).id, namedNode(SAREF_HAS_TIMESTAMP, null));

            if (timestamp_one > timestamp_two) {
                merged.push(array_one[i]);
                i++;
            }
            else {
                merged.push(array_two[j]);
                j++;
            }
        }

        while (i < array_one.length) {
            merged.push(array_one[i]);
            i++;
        }

        while (j < array_two.length) {
            merged.push(array_two[j]);
            j++;
        }

        return merged;
    }

    private async resolveLdesInbox(ldesLocation: string, treePath: string): Promise<string> {
        const ldes_stream = new LDESinLDP(ldesLocation, this.communication);
        await ldes_stream.initialise({ treePath });
        const store = new N3.Store();
        const response = await axios.get(ldesLocation);
        await parser.parse(response.data, (error: any, quad: any) => {
            if (error) {
                throw new Error(`Error while parsing LDES stream ${ldesLocation}: ${error.message}`);
            }
            if (quad) {
                store.addQuad(quad);
            }
        });
        const inbox = store.getQuads(null, 'http://www.w3.org/ns/ldp#inbox', null)[0]?.object?.value;
        if (!inbox) {
            throw new Error(`The inbox could not be extracted for ${ldesLocation}.`);
        }
        return `${ldesLocation}${inbox}`;
    }

    async post_with_retry(container: string, data: string, headers: Headers, retries: number, backoff: number): Promise<void> {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await this.uma_fetcher.fetch(container, {
                    method: 'POST',
                    body: data,
                    headers: headers,
                });
                if (response.status >= 200 && response.status < 300) {
                    this.number_of_post++;
                    fs.appendFileSync('replayer-log.csv', `${Date.now()},${this.number_of_post},${container},${data}\n`, { flag: 'a' });
                    const benchmarkRunId = process.env.BENCHMARK_RUN_ID || 'unknown';
                    await this.notifyPandaWebhook(container, response.headers?.get?.('location') ?? null, data, benchmarkRunId);
                    console.log(`[BENCHMARK_REPLAYER] event_posted benchmark_run_id=${benchmarkRunId} count=${this.number_of_post} status=${response.status} target=${container}`);
                    return;
                }
                throw new Error(`Failed to post to ${container}: ${response.status}`);
            } catch (error) {
                if (attempt < retries) {
                    const delay = backoff * Math.pow(2, attempt - 1);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                } else {
                    throw error;
                }
            }
        }
    }

    public async authorizeFetch(container_to_publish: string) {
        await this.uma_fetcher.preAuthorize(container_to_publish);
    }

    private async notifyPandaWebhook(topic: string, locationHeader: string | null, data: string, benchmarkRunId: string): Promise<void> {
        const webhookUrl = process.env.REPLAYER_PANDA_WEBHOOK_URL;
        if (!webhookUrl) {
            return;
        }
        const target = locationHeader ? new URL(locationHeader, topic).toString() : topic;
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                type: 'Add',
                topic,
                target,
                benchmark_run_id: benchmarkRunId,
                count: this.number_of_post,
                data
            })
        });
        if (!response.ok) {
            throw new Error(`PANDA webhook notify failed status=${response.status}`);
        }
    }

    private assertQueueItemInvariant(item: QueueItem): void {
        if (item.stream_location !== this.stream.location || item.container !== this.container_to_publish) {
            throw new Error(
                `Queue item invariant violated: expected (${this.stream.location}, ${this.container_to_publish}) but got (${item.stream_location}, ${item.container})`
            );
        }
    }

    private normalizeAndValidateDataset(): void {
        const observationSubjects = new Set<string>();
        for (const quad of this.store.match(null, 'https://saref.etsi.org/core/measurementMadeBy', null)) {
            observationSubjects.add(quad.subject.id);
        }

        observationSubjects.forEach((subjectId) => {
            const subjectNode = namedNode(subjectId);
            const sarefTimestamps = this.store.getQuads(subjectNode, namedNode(SAREF_HAS_TIMESTAMP), null, null);
            const issuedTimestamps = this.store.getQuads(subjectNode, namedNode(DCTERMS_ISSUED), null, null);

            if (sarefTimestamps.length === 0 && issuedTimestamps.length === 0) {
                throw new Error(`Invalid benchmark event ${subjectId}: missing ${SAREF_HAS_TIMESTAMP}`);
            }

            const selected = sarefTimestamps[0] ?? issuedTimestamps[0];
            const normalized = this.normalizeTimestamp(selected.object.value, subjectId);

            this.store.removeQuads([...sarefTimestamps, ...issuedTimestamps]);
            this.store.addQuad(subjectNode, namedNode(SAREF_HAS_TIMESTAMP), literal(normalized, namedNode(XSD_DATETIME)));
        });
    }

    private normalizeTimestamp(rawTimestamp: string, subjectId: string): string {
        if (typeof rawTimestamp !== 'string' || rawTimestamp.trim() === '') {
            throw new Error(`Invalid benchmark event ${subjectId}: timestamp is empty`);
        }
        const timestamp = rawTimestamp.trim();
        if (timestamp.endsWith('NZ')) {
            throw new Error(`Invalid benchmark event ${subjectId}: timestamp must end with Z, got ${timestamp}`);
        }

        const parsedMs = Date.parse(timestamp);
        if (Number.isNaN(parsedMs)) {
            throw new Error(`Invalid benchmark event ${subjectId}: timestamp is not parseable (${timestamp})`);
        }

        const normalized = new Date(parsedMs).toISOString();
        if (!normalized.endsWith('Z')) {
            throw new Error(`Invalid benchmark event ${subjectId}: normalized timestamp must end with Z, got ${normalized}`);
        }
        return normalized;
    }

    private validateObservationPayload(payload: string, subjectId: string): void {
        const dataset = this.storeFromString(payload);
        const subjectNode = namedNode(subjectId);
        const timestamp = dataset.getQuads(subjectNode, namedNode(SAREF_HAS_TIMESTAMP), null, null)[0]?.object?.value;
        if (!timestamp) {
            throw new Error(`Invalid benchmark event ${subjectId}: payload missing ${SAREF_HAS_TIMESTAMP}`);
        }
        if (Number.isNaN(Date.parse(timestamp))) {
            throw new Error(`Invalid benchmark event ${subjectId}: payload timestamp is not parseable (${timestamp})`);
        }
    }

    private storeFromString(input: string): any {
        const localParser = new N3.Parser();
        const localStore = new N3.Store();
        const quads = localParser.parse(input);
        localStore.addQuads(quads);
        return localStore;
    }
}
