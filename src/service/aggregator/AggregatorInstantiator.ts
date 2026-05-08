import { RSPEngine } from "rsp-js";
import { RSPQLParser } from "../parsers/RSPQLParser";
import { DecentralizedFileStreamer } from "./DecentralizedFileStreamer";
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from "events";
import * as CREDENTIALS from '../../config/PodToken.json';
import { BindingsWithTimestamp } from "../../utils/Types";
import { hash_string_md5 } from "../../utils/Util";
import { Credentials, aggregation_object } from "../../utils/Types";
import { DataFactory, Parser } from "n3";
import { NotificationStreamProcessor } from "./NotificationStreamProcessor";
import { ContinuousAnomalyMonitoringService } from "../reasoner/ContinuousAnomalyMonitoringService";
import { getUmaClaim } from "../../config/UmaClaim";
import { parseAuthenticateHeader } from "../authorization/UserManagedAccessFetcher";
import { BenchmarkTimingContext, cloneBenchmarkTiming, maybeMarkBenchmarkNs } from "../../utils/benchmark/BenchmarkTiming";
const WebSocketClient = require('websocket').client;
const websocketConnection = require('websocket').connection;
const parser = new RSPQLParser();
/**
 * Class for the Aggregator Instantiator.
 * @class AggregatorInstantiator
 */
export class AggregatorInstantiator {
    private static readonly LOW_SPO2_THRESHOLD = 90;
    private static readonly ALERT_CONTAINER = 'http://localhost:3000/alice/derived/anomaly-alert/';
    private static readonly ALERT_PREFIX = 'http://example.org/alert#';
    private static readonly XSD_PREFIX = 'http://www.w3.org/2001/XMLSchema#';
    private static readonly ALICE_ALERT_WRITE_TOKEN_ENV = 'PANDA_ALICE_WRITE_TOKEN';
    private static readonly UMA_TICKET_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:uma-ticket';
    private static readonly WEBID_CLAIM_FORMAT = 'urn:solidlab:uma:claims:formats:webid';
    public query: string;
    public rules: string;
    public rsp_engine: RSPEngine;
    public rsp_emitter: EventEmitter;
    public event_emitter: EventEmitter;
    public from_date: Date;
    public stream_array: string[];
    public hash_string: string;
    public logger: any;
    public to_date: Date;
    public client = new WebSocketClient();
    public connection: typeof websocketConnection;
    private alertContainerInitialized = false;
    private fallbackAlertWriteAuthorizationHeader: string | null = null;
    private readonly auditContext?: QueryExecutionAuditContext;
    private readonly projectedVariables: string[];
    private readonly aggregationFunction: string;
    private readonly windowWidthMs: number;
    /**
     * Creates an instance of AggregatorInstantiator.
     * @param {string} query - The RSPQL query.
     * @param {string} rules - The rules for the query.
     * @param {number} from_timestamp - The timestamp from where the query is to be executed.
     * @param {number} to_timestamp - The timestamp to where the query is to be executed.
     * @param {*} logger - The logger object.
     * @param {string} query_type - The type of the query (either 'historical+live' or just 'live').
     * @param {any} event_emitter - The event emitter object.
     * @memberof AggregatorInstantiator
     */
    public constructor(query: string, rules: string, from_timestamp: number, to_timestamp: number, logger: any, query_type: string, event_emitter: any, auditContext?: QueryExecutionAuditContext) {
        this.query = query;
        this.rules = rules;
        this.logger = logger;
        this.event_emitter = event_emitter;
        this.auditContext = auditContext;
        this.hash_string = hash_string_md5(query);
        this.rsp_engine = new RSPEngine(query);
        this.from_date = new Date(from_timestamp);
        this.to_date = new Date(to_timestamp);
        this.stream_array = [];
        this.connection = websocketConnection;
        const parsedQuery = parser.parse(this.query);
        this.projectedVariables = parsedQuery.projection_variables;
        this.aggregationFunction = parsedQuery.aggregation_function;
        this.windowWidthMs = parsedQuery.s2r[0]?.width ?? 0;
        parsedQuery.s2r.forEach((stream) => {
            this.stream_array.push(stream.stream_name);
        });
        this.rsp_emitter = this.rsp_engine.register();
        this.initializeProcessing(query_type);
    }

    /**
     * Initialize the processing of the query.
     * @param {string} query_type - The type of the query (either 'historical+live' or just 'live').
     * @returns {Promise<boolean>} - Returns true if the processing is successful, otherwise false.
     * @memberof AggregatorInstantiator
     */
    public async initializeProcessing(query_type: string): Promise<boolean> {
        const query_hashed = hash_string_md5(this.query);
        this.logger.info({}, 'stream_processing_from_solid_pod_initialized');
        if (this.stream_array.length !== 0) {
            if (query_type === 'historical+live') {
                for (const stream of this.stream_array) {
                    const session_credentials = this.get_session_credentials(stream);
                    this.logger.info({ query_hashed }, `stream_credentials_retrieved`);
                    new DecentralizedFileStreamer(stream, session_credentials, this.from_date, this.to_date, this.rsp_engine, this.query, this.logger, this.auditContext);
                }
                this.subscribeRStream();
                return true;
            }
            else if (query_type === 'live') {
                console.log(`The query type is live.`);
                for (const stream of this.stream_array) {
                    this.logger.info({ query_hashed }, `stream_credentials_retrieved`);
                    new NotificationStreamProcessor(stream, this.logger, this.rsp_engine, this.event_emitter, this.auditContext);
                }
                this.subscribeRStream();
                return true;
            }
            else {
                throw new Error('The query type is not currently supported by the Solid Stream Aggregator.');
            }
        }
        else {
            console.log(`The stream array is empty. The query is not valid.`);
            return false;
        }
    }

    /**
     * Subscribe to the RStream of the RSP Engine to listen to the bindings, i.e the generated aggregation events and send it to the Solid Stream Aggregator's Websocket server for further processing (i.e publishing to the Solid Pod & sending to the clients).
     * @memberof AggregatorInstantiator
     */
    public async subscribeRStream() {
        maybeMarkBenchmarkNs(this.auditContext?.benchmarkTiming, 'rsp_subscription_started_at_ns', true);
        this.connect_with_server('ws://localhost:8080/').then(() => {
            console.log(`The connection with the websocket server has been established.`);
            this.connection.connected = true;
        });
        this.client.on('connect', (connection: typeof websocketConnection) => {
            console.log(`The connection with the server has been established. ${connection.connected}`);
            this.rsp_emitter.on('RStream', async (object: BindingsWithTimestamp) => {
                if (this.auditContext?.benchmarkTiming && !this.auditContext.benchmarkTiming.firstWindowEvaluatedRecorded) {
                    maybeMarkBenchmarkNs(this.auditContext.benchmarkTiming, 'rsp_window_evaluated_at_ns', true);
                    this.auditContext.benchmarkTiming.firstWindowEvaluatedRecorded = true;
                }
                const evaluation_now = Date.now();
                const normalizedWindow = this.normalizeWindowTimestamps(
                    object.timestamp_from,
                    object.timestamp_to,
                    evaluation_now
                );
                const window_timestamp_from = normalizedWindow.from;
                const window_timestamp_to = normalizedWindow.to;
                console.log(`[VALIDATION][RSP] evaluation_tick processing_time_epoch=${evaluation_now} processing_time_iso=${new Date(evaluation_now).toISOString()} window_start_epoch=${window_timestamp_from} window_start_iso=${new Date(window_timestamp_from).toISOString()} window_end_epoch=${window_timestamp_to} window_end_iso=${new Date(window_timestamp_to).toISOString()}`);
                this.debugBindingRowShape(object.bindings);
                const extractedBindingRows = this.extractBindingRows(object.bindings);
                const bindingRows = this.reduceBindingRowsForEvaluation(extractedBindingRows);
                console.log(`[VALIDATION][RSP] binding_count=${object.bindings.size}`);
                console.log(`[VALIDATION][RSP] emitted_row_count=${bindingRows.length}`);
                for (const [rowIndex, bindingRow] of bindingRows.entries()) {
                    console.log(`[VALIDATION][RSP] query_row_received row_index=${rowIndex} row=${JSON.stringify(bindingRow)}`);
                    this.debugBindingRowVariables(bindingRow, rowIndex);
                    const sourceEventUri = bindingRow['?s'] ?? bindingRow['s'] ?? this.findUriLikeValue(bindingRow);
                    const spo2Raw = this.resolveProjectedNumericValue(bindingRow);
                    const numericSpo2 = Number(spo2Raw);
                    if (!Number.isFinite(numericSpo2)) {
                        console.log(`[VALIDATION][RSP] skipped_non_numeric row_index=${rowIndex} row=${JSON.stringify(bindingRow)}`);
                        continue;
                    }
                    console.log(`[VALIDATION][RSP] extracted_numeric_value spo2Value=${numericSpo2}`);
                    console.log(`[VALIDATION][RSP] extracted_source_event_uri sourceEventUri=${sourceEventUri ?? 'undefined'}`);
                    console.log(`[MEASURE][RULE] evaluation_started timestamp=${new Date().toISOString()} event_id=${sourceEventUri ?? 'unknown'}`);
                    const aggregation_event_timestamp = new Date().getTime();
                    const data = String(numericSpo2);
                    console.log(`Event Generated is ${data}`);
                    const aggregation_event = this.generate_aggregation_event(data, aggregation_event_timestamp, this.stream_array, window_timestamp_from, window_timestamp_to);
                    console.log(`Aggregation Event is ${aggregation_event}`)
                    console.log(`[VALIDATION][RULE] assertions_for_rule_engine row_index=${rowIndex} assertions=${JSON.stringify(aggregation_event)}`);
                    if (this.rules === '') {
                        const fetched_rules = await this.fetch_rules_from_query(this.query);
                        if (fetched_rules) {
                        const reasoner = ContinuousAnomalyMonitoringService.getInstance(fetched_rules);
                            if (this.auditContext?.benchmarkTiming && !this.auditContext.benchmarkTiming.firstRuleEvalRecorded) {
                                maybeMarkBenchmarkNs(this.auditContext.benchmarkTiming, 'rule_eval_started_at_ns', true);
                            }
                            const reasoned_result = await reasoner.reason(aggregation_event);
                            if (this.auditContext?.benchmarkTiming && !this.auditContext.benchmarkTiming.firstRuleEvalRecorded) {
                                maybeMarkBenchmarkNs(this.auditContext.benchmarkTiming, 'rule_eval_finished_at_ns', true);
                                this.auditContext.benchmarkTiming.firstRuleEvalRecorded = true;
                            }
                            const inferredAlert = this.reasonerOutputContainsAlert(reasoned_result);
                            console.log(`[VALIDATION][RULE] inferred_alert_triple_present=${inferredAlert} row_index=${rowIndex}`);
                            if (inferredAlert) {
                                console.log(`[MEASURE][RULE] matched timestamp=${new Date().toISOString()} event_id=${sourceEventUri ?? 'unknown'} value=${numericSpo2}`);
                                await this.materializeLowSpo2Alert(sourceEventUri, numericSpo2);
                            }
                            const aggregation_object: aggregation_object = {
                                query_hash: this.hash_string,
                                aggregation_event: reasoned_result.trim().length > 0 ? reasoned_result : aggregation_event,
                                aggregation_window_from: new Date(window_timestamp_from),
                                aggregation_window_to: new Date(window_timestamp_to),
                                benchmark_timing: cloneBenchmarkTiming(this.auditContext?.benchmarkTiming),
                            };
                            const aggregation_object_string = JSON.stringify(aggregation_object);
                            this.sendToServer(aggregation_object_string);
                            this.logger.info({}, 'aggregation_event_sent_to_solid_stream_aggregator_websocket_server');
                        }
                        else {
                            throw new Error("The rules could not be fetched from the Solid Pod.");
                        }
                    }
                    else {
                        const reasoner = ContinuousAnomalyMonitoringService.getInstance(this.rules);
                        console.log(this.rules);
                        console.log(`[VALIDATION][RULE] evaluation_started processing_time_epoch=${Date.now()} has_rules_inline=${this.rules !== ''}`);
                        if (this.auditContext?.benchmarkTiming && !this.auditContext.benchmarkTiming.firstRuleEvalRecorded) {
                            maybeMarkBenchmarkNs(this.auditContext.benchmarkTiming, 'rule_eval_started_at_ns', true);
                        }
                        const reasoned_result = await reasoner.reason(aggregation_event);
                        if (this.auditContext?.benchmarkTiming && !this.auditContext.benchmarkTiming.firstRuleEvalRecorded) {
                            maybeMarkBenchmarkNs(this.auditContext.benchmarkTiming, 'rule_eval_finished_at_ns', true);
                            this.auditContext.benchmarkTiming.firstRuleEvalRecorded = true;
                        }
                        console.log(`Reasoned Result is ${reasoned_result}`);
                        const inferredAlert = this.reasonerOutputContainsAlert(reasoned_result);
                        console.log(`[VALIDATION][RULE] inferred_alert_triple_present=${inferredAlert} row_index=${rowIndex}`);
                        if (inferredAlert) {
                            console.log(`[MEASURE][RULE] matched timestamp=${new Date().toISOString()} event_id=${sourceEventUri ?? 'unknown'} value=${numericSpo2}`);
                            await this.materializeLowSpo2Alert(sourceEventUri, numericSpo2);
                        }
                        const aggregation_object: aggregation_object = {
                            query_hash: this.hash_string,
                            aggregation_event: reasoned_result.trim().length > 0 ? reasoned_result : aggregation_event,
                            aggregation_window_from: new Date(window_timestamp_from),
                            aggregation_window_to: new Date(window_timestamp_to),
                            benchmark_timing: cloneBenchmarkTiming(this.auditContext?.benchmarkTiming),
                        };
                        const aggregation_object_string = JSON.stringify(aggregation_object);
                        this.sendToServer(aggregation_object_string);
                        this.logger.info({}, 'aggregation_event_sent_to_solid_stream_aggregator_websocket_server');
                    }
                }
            })
        });
    }

    async fetch_rules_from_query(rsp_ql_query: string): Promise<string | undefined> {
        const stream_match_regex = /<([^>]+)>/;
        const stream_match = rsp_ql_query.match(stream_match_regex);
        if (stream_match !== null) {
            const stream = stream_match[1];
            const webID = stream.replace(/\/[^/]+$/, '/profile/card#me');
            const response = await fetch(webID, {
                method: 'GET',
                headers: {
                    'Accept': 'text/turtle,text/n3;q=0.9',
                }
            });

            if (!response.ok) {
                throw new Error("The response from the Solid Pod is not OK. It failed to fetch the profile document.");
            }

            const webIDTurtle = await response.text();
            const parser = new Parser();
            const triples = parser.parse(webIDTurtle);

            for (const triple of triples) {
                if (triple.predicate.value === 'http://example.org/hasRuleLocation') {
                    const rule_location = triple.object.value;
                    const rule_response = await fetch(rule_location, {
                        method: 'GET',
                        headers: {
                            'Accept': 'text/turtle,text/n3;q=0.9',
                        }
                    });

                    if (!rule_response.ok) {
                        throw new Error("The response from the Solid Pod is not OK. It failed to fetch the rule document.");
                    }
                    const n3_rules = await rule_response.text();
                    return n3_rules;
                }
            }
        }
        else {
            throw new Error("The stream match is null.");
            return undefined;
        }
    }

    // TODO : add extra projection variables to the aggregation event.
    // Relevant Issue : https://github.com/SolidLabResearch/solid-stream-aggregator/issues/34
    /**
     * Generate an aggregation event.
     * @param {string} value - The value of the aggregation event.
     * @param {number} event_timestamp - The timestamp of the aggregation event when it was generated.
     * @param {(string[] | undefined)} stream_array - The array of streams that the aggregation event is generated from.
     * @param {number} timestamp_from - The timestamp of the start of the aggregation window.
     * @param {number} timestamp_to -  The timestamp of the end of the aggregation window.
     * @returns {string} - The aggregation event in string RDF.
     * @memberof AggregatorInstantiator
     */
    generate_aggregation_event(
        value: string,
        event_timestamp: number,
        stream_array: string[] | undefined,
        timestamp_from: number,
        timestamp_to: number
    ): string {
        if (stream_array === undefined) {
            throw new Error("The stream array is undefined.");
        } else {
            const timestamp_date = new Date(event_timestamp).toISOString();
            const timestamp_from_date = new Date(timestamp_from).toISOString();
            const timestamp_to_date = new Date(timestamp_to).toISOString();
            const uuid_random = uuidv4();

            let aggregation_event = `
    <https://rsp.js/aggregation_event/${uuid_random}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://saref.etsi.org/core/Measurement> .
    <https://rsp.js/aggregation_event/${uuid_random}> <https://saref.etsi.org/core/hasTimestamp> "${timestamp_date}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
    <https://rsp.js/aggregation_event/${uuid_random}> <https://saref.etsi.org/core/hasValue> "${value}"^^<http://www.w3.org/2001/XMLSchema#float> .
    <https://rsp.js/aggregation_event/${uuid_random}> <http://www.w3.org/ns/prov#wasDerivedFrom> <https://argahsuknesib.github.io/asdo/AggregatorService> .
    <https://rsp.js/aggregation_event/${uuid_random}> <http://w3id.org/rsp/vocals-sd#startedAt> "${timestamp_from_date}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
    <https://rsp.js/aggregation_event/${uuid_random}> <http://w3id.org/rsp/vocals-sd#endedAt> "${timestamp_to_date}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
    `;

            for (const stream of stream_array) {
                aggregation_event += `<https://rsp.js/aggregation_event/${uuid_random}> <http://www.w3.org/ns/prov#generatedBy> <${stream}> .\n`;
            }

            return aggregation_event.trim();
        }
    }

    /**
     * Connect with the Websocket server of the Solid Stream Aggregator.
     * @param {string} wssURL - The URL of the Websocket server of the Solid Stream Aggregator.
     * @memberof AggregatorInstantiator
     */
    async connect_with_server(wssURL: string) {
        this.client.connect(wssURL, 'solid-stream-aggregator-protocol');
        this.client.on('connectFailed', (error: Error) => {
            console.log('Connect Error: ' + error.toString());
            this.auditContext?.onExecutionFailed?.(error.message);
        });
        this.client.setMaxListeners(Infinity);
        this.client.on('connect', (connection: typeof websocketConnection) => {
            this.connection = connection;
        });
    }
    /**
     * Send a message to the Websocket server of the Solid Stream Aggregator.
     * @param {string} message - The message to be sent.
     * @memberof AggregatorInstantiator
     */
    sendToServer(message: string) {
        if (this.connection.connected) {
            this.connection.sendUTF(message);
        }
        else {
            this.connect_with_server('ws://localhost:8080/').then(() => {
                console.log(`The connection with the websocket server was not established. It is now established.`);
            });
        }
    }
    /**
     * Get the session credentials for the Solid Pod.
     * @param {string} stream_name - The name of the stream (i.e the LDES in LDP of the Solid Pod).
     * @returns {Credentials} - The session credentials.
     * @memberof AggregatorInstantiator
     */
    get_session_credentials(stream_name: string) {
        const credentials: Credentials = CREDENTIALS;
        const session_credentials = credentials[stream_name];
        return session_credentials;
    }

    private parseBindingRow(item: any): Record<string, string> {
        const row: Record<string, string> = {};
        if (!item || typeof item !== 'object') {
            return row;
        }
        if (typeof (item as any).forEach === 'function') {
            (item as any).forEach((value: any, key: any) => {
                const normalizedKey = this.normalizeBindingKey(key);
                const normalizedValue = this.normalizeBindingValue(value);
                row[normalizedKey] = normalizedValue;
                for (const alias of this.generateKeyAliases(normalizedKey)) {
                    if (row[alias] === undefined) {
                        row[alias] = normalizedValue;
                    }
                }
            });
            return row;
        }
        for (const [key, value] of Object.entries(item as Record<string, any>)) {
            const normalizedValue = this.normalizeBindingValue(value);
            row[key] = normalizedValue;
            for (const alias of this.generateKeyAliases(key)) {
                if (row[alias] === undefined) {
                    row[alias] = normalizedValue;
                }
            }
        }
        return row;
    }

    private extractBindingRows(item: any): Record<string, string>[] {
        if (!item || typeof item !== 'object') {
            return [];
        }

        if (typeof item.forEach === 'function') {
            const entries: Array<[any, any]> = [];
            item.forEach((value: any, key: any) => entries.push([key, value]));
            if (entries.length === 0) {
                return [];
            }
            const looksLikeSingleBindingRow = entries.every(([key]) => this.isBindingVariableKey(key));
            if (looksLikeSingleBindingRow) {
                return [this.parseBindingRow(item)];
            }
            return entries
                .map(([, value]) => this.parseBindingRow(value))
                .filter((row) => Object.keys(row).length > 0);
        }

        if (typeof item[Symbol.iterator] === 'function' && !Array.isArray(item)) {
            const rows: Record<string, string>[] = [];
            for (const element of item as Iterable<any>) {
                const row = this.parseBindingRow(element);
                if (Object.keys(row).length > 0) {
                    rows.push(row);
                }
            }
            if (rows.length > 0) {
                return rows;
            }
        }

        const fallbackRow = this.parseBindingRow(item);
        return Object.keys(fallbackRow).length > 0 ? [fallbackRow] : [];
    }

    private reduceBindingRowsForEvaluation(bindingRows: Record<string, string>[]): Record<string, string>[] {
        if (bindingRows.length <= 1) {
            return bindingRows;
        }
        if (!this.aggregationFunction) {
            return bindingRows;
        }

        const firstProjectedRow = bindingRows.find((row) => this.resolveProjectedNumericValue(row) !== undefined);
        return firstProjectedRow ? [firstProjectedRow] : [bindingRows[0]];
    }

    private isBindingVariableKey(key: any): boolean {
        if (typeof key === 'string') {
            return key.startsWith('?') || /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
        }
        if (!key || typeof key !== 'object') {
            return false;
        }
        const candidate = key.value ?? key.variable ?? key.name ?? key.id;
        return typeof candidate === 'string' && candidate.length > 0;
    }

    private normalizeBindingKey(key: any): string {
        if (typeof key === 'string') {
            return key;
        }
        if (!key || typeof key !== 'object') {
            return String(key);
        }

        const variableNameCandidate = key.value ?? key.id ?? key.variable ?? key.name;
        if (typeof variableNameCandidate === 'string' && variableNameCandidate.length > 0) {
            const trimmed = variableNameCandidate.trim();
            if (trimmed.startsWith('?')) {
                return trimmed;
            }
            if (!trimmed.includes(':') && !trimmed.startsWith('http')) {
                return `?${trimmed}`;
            }
            return trimmed;
        }

        if (typeof key.toString === 'function') {
            const rendered = key.toString();
            if (rendered && rendered !== '[object Object]') {
                return rendered;
            }
        }
        return String(key);
    }

    private normalizeBindingValue(value: any): string {
        if (value === undefined || value === null) {
            return String(value);
        }
        if (typeof value !== 'object') {
            return String(value);
        }
        if (value.value !== undefined) {
            return String(value.value);
        }
        if (typeof value.id === 'string') {
            return value.id;
        }
        if (typeof value.toString === 'function') {
            const rendered = value.toString();
            if (rendered && rendered !== '[object Object]') {
                return rendered;
            }
        }
        return String(value);
    }

    private generateKeyAliases(key: string): string[] {
        if (!key || key === '[object Object]') {
            return [];
        }
        if (key.startsWith('?')) {
            return [key.slice(1)];
        }
        if (!key.includes(':') && !key.startsWith('http')) {
            return [`?${key}`];
        }
        return [];
    }

    private findNumericValue(bindingRow: Record<string, string>): string | undefined {
        const candidate = Object.values(bindingRow).find((value) => Number.isFinite(Number(value)));
        return candidate;
    }

    private resolveProjectedNumericValue(bindingRow: Record<string, string>): string | undefined {
        for (const projectedVariable of this.projectedVariables) {
            const normalizedCandidates = projectedVariable.startsWith('?')
                ? [projectedVariable, projectedVariable.slice(1)]
                : [projectedVariable, `?${projectedVariable}`];
            for (const candidate of normalizedCandidates) {
                const value = bindingRow[candidate];
                if (value !== undefined && Number.isFinite(Number(value))) {
                    return value;
                }
            }
        }

        const aggregateFallbacks = ['?avg', 'avg', '?max', 'max', '?min', 'min', '?sum', 'sum', '?count', 'count'];
        for (const candidate of aggregateFallbacks) {
            const value = bindingRow[candidate];
            if (value !== undefined && Number.isFinite(Number(value))) {
                return value;
            }
        }

        return bindingRow['?spo2Value'] ?? bindingRow['spo2Value'] ?? this.findNumericValue(bindingRow);
    }

    private normalizeWindowTimestamps(timestampFrom: number, timestampTo: number, evaluationNow: number): { from: number; to: number } {
        const minLikelyEpochMs = Date.UTC(2000, 0, 1);
        const rawFromIsEpoch = Number.isFinite(timestampFrom) && timestampFrom >= minLikelyEpochMs;
        const rawToIsEpoch = Number.isFinite(timestampTo) && timestampTo >= minLikelyEpochMs;

        if (rawFromIsEpoch && rawToIsEpoch && timestampTo >= timestampFrom) {
            return { from: timestampFrom, to: timestampTo };
        }

        const normalizedTo = evaluationNow;
        const normalizedFrom = this.windowWidthMs > 0 ? evaluationNow - this.windowWidthMs : evaluationNow;
        return { from: normalizedFrom, to: normalizedTo };
    }

    private findUriLikeValue(bindingRow: Record<string, string>): string | undefined {
        const candidate = Object.values(bindingRow).find((value) => typeof value === 'string' && /^https?:\/\//.test(value));
        return candidate;
    }

    private reasonerOutputContainsAlert(reasonedResult: string): boolean {
        return ContinuousAnomalyMonitoringService.outputContainsAlertTriple(reasonedResult);
    }

    private debugBindingRowVariables(bindingRow: Record<string, string>, rowIndex: number): void {
        const variableNames = Object.keys(bindingRow);
        console.log(`[VALIDATION][RSP] row_variables row_index=${rowIndex} variable_names=${JSON.stringify(variableNames)}`);
        const details = variableNames.map((name) => {
            const value = bindingRow[name];
            const numericCandidate = Number(value);
            return {
                variable: name,
                value,
                datatype: Number.isFinite(numericCandidate) ? 'numeric' : 'string_or_iri',
            };
        });
        console.log(`[VALIDATION][RSP] row_values row_index=${rowIndex} details=${JSON.stringify(details)}`);
    }

    private debugBindingRowShape(item: any): void {
        const debugPrefix = '[VALIDATION][RSP][ROW_DEBUG]';
        const safeSerialize = (value: any): string => {
            try {
                const seen = new WeakSet<object>();
                return JSON.stringify(value, (_key, nestedValue) => {
                    if (nestedValue instanceof Map) {
                        return {
                            __type: 'Map',
                            entries: Array.from(nestedValue.entries()).map(([mapKey, mapValue]) => ({
                                key: this.describeNested(mapKey),
                                value: this.describeNested(mapValue),
                            })),
                        };
                    }
                    if (nestedValue && typeof nestedValue === 'object') {
                        if (seen.has(nestedValue)) {
                            return '[Circular]';
                        }
                        seen.add(nestedValue);
                    }
                    return nestedValue;
                });
            } catch (error) {
                return `[[unserializable:${(error as Error).message}]]`;
            }
        };

        console.log(`${debugPrefix} raw=${safeSerialize(item)}`);
        console.log(`${debugPrefix} typeof=${typeof item} tag=${Object.prototype.toString.call(item)}`);

        if (item && typeof item === 'object') {
            console.log(`${debugPrefix} keys=${safeSerialize(Object.keys(item))}`);
            if (typeof item.entries === 'function') {
                const entries = Array.from(item.entries() as Iterable<[any, any]>).slice(0, 10).map(([key, value]) => ({
                    key: this.describeNested(key),
                    value: this.describeNested(value),
                }));
                console.log(`${debugPrefix} entries=${safeSerialize(entries)}`);
            } else if (typeof item[Symbol.iterator] === 'function') {
                const entries = Array.from(item as Iterable<any>).slice(0, 10).map((entry) => this.describeNested(entry));
                console.log(`${debugPrefix} iterable_entries=${safeSerialize(entries)}`);
            }

            for (const [outerKey, outerValue] of Object.entries(item as Record<string, any>)) {
                if (outerValue && typeof outerValue === 'object') {
                    const nestedKeys = Object.keys(outerValue);
                    const nestedValue = (outerValue as any).value;
                    console.log(`${debugPrefix} nested key=${outerKey} nested_keys=${safeSerialize(nestedKeys)} nested_value=${safeSerialize(nestedValue)}`);
                }
            }
        }
    }

    private describeNested(value: any): any {
        if (value === null || value === undefined) {
            return value;
        }
        if (typeof value !== 'object') {
            return value;
        }
        return {
            type: value.constructor?.name ?? typeof value,
            keys: Object.keys(value),
            value: value.value,
            id: value.id,
            termType: value.termType,
            toString: typeof value.toString === 'function' ? value.toString() : undefined,
        };
    }

    private resolveAlertWriteToken(): string | null {
        const rawToken = process.env[AggregatorInstantiator.ALICE_ALERT_WRITE_TOKEN_ENV]?.trim() ?? '';
        const hasToken = rawToken.length > 0;
        const tokenPreview = hasToken
            ? `${rawToken.slice(0, 8)}...${rawToken.slice(-8)}`
            : 'missing';
        let tokenStatus = 'missing';
        let tokenExpIso = 'n/a';

        if (hasToken) {
            tokenStatus = 'present';
            const tokenParts = rawToken.split('.');
            if (tokenParts.length === 3) {
                try {
                    const payloadJson = Buffer.from(tokenParts[1], 'base64url').toString('utf8');
                    const payload = JSON.parse(payloadJson) as { exp?: number };
                    if (payload.exp) {
                        tokenExpIso = new Date(payload.exp * 1000).toISOString();
                        if (Date.now() >= payload.exp * 1000) {
                            tokenStatus = 'expired';
                        } else {
                            tokenStatus = 'valid_jwt';
                        }
                    }
                } catch {
                    tokenStatus = 'present_non_parseable_jwt';
                }
            }
        }

        console.log(`[VALIDATION][ALERT][TOKEN] env=${AggregatorInstantiator.ALICE_ALERT_WRITE_TOKEN_ENV} status=${tokenStatus} exp=${tokenExpIso} preview=${tokenPreview}`);
        if (!hasToken || tokenStatus === 'expired') {
            return null;
        }
        return rawToken;
    }

    private formatClaimToken(claimToken: string, claimTokenFormat: string): string {
        if (claimTokenFormat === AggregatorInstantiator.WEBID_CLAIM_FORMAT) {
            return encodeURIComponent(claimToken);
        }
        return claimToken;
    }

    private async resolveAlertWriteAuthorizationHeader(): Promise<string | null> {
        const configuredToken = this.resolveAlertWriteToken();
        if (configuredToken) {
            return `Bearer ${configuredToken}`;
        }
        if (this.fallbackAlertWriteAuthorizationHeader) {
            return this.fallbackAlertWriteAuthorizationHeader;
        }
        const claim = getUmaClaim();
        try {
            const challengeResponse = await fetch(AggregatorInstantiator.ALERT_CONTAINER, {
                method: 'POST',
                headers: { 'Content-Type': 'text/turtle' },
                body: '',
            });
            if (challengeResponse.status !== 401) {
                console.log(`[VALIDATION][ALERT][TOKEN] fallback_challenge_unexpected_status status=${challengeResponse.status}`);
                return null;
            }
            const { tokenEndpoint, ticket } = parseAuthenticateHeader(challengeResponse.headers as Headers);
            const tokenResponse = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    grant_type: AggregatorInstantiator.UMA_TICKET_GRANT_TYPE,
                    ticket,
                    claim_token: this.formatClaimToken(claim.token, claim.token_format),
                    claim_token_format: claim.token_format,
                }),
            });
            const tokenBody = await tokenResponse.text().catch(() => '');
            if (tokenResponse.status !== 200) {
                console.log(`[VALIDATION][ALERT][TOKEN] fallback_exchange_failed status=${tokenResponse.status} body=${JSON.stringify(tokenBody)}`);
                return null;
            }
            let parsedToken: { access_token?: string; token_type?: string } = {};
            try {
                parsedToken = JSON.parse(tokenBody) as { access_token?: string; token_type?: string };
            } catch {
                console.log(`[VALIDATION][ALERT][TOKEN] fallback_exchange_non_json body=${JSON.stringify(tokenBody)}`);
                return null;
            }
            if (!parsedToken.access_token) {
                console.log(`[VALIDATION][ALERT][TOKEN] fallback_exchange_missing_access_token body=${JSON.stringify(tokenBody)}`);
                return null;
            }
            const tokenType = parsedToken.token_type || 'Bearer';
            this.fallbackAlertWriteAuthorizationHeader = `${tokenType} ${parsedToken.access_token}`;
            console.log(`[VALIDATION][ALERT][TOKEN] fallback_token_acquired type=${tokenType}`);
            return this.fallbackAlertWriteAuthorizationHeader;
        } catch (error) {
            const err = error as Error;
            console.log(`[VALIDATION][ALERT][TOKEN] fallback_exchange_error message=${JSON.stringify(err.message)} stack=${JSON.stringify(err.stack ?? '')}`);
            return null;
        }
    }

    private logAlertHttpRequestTrace(url: string, method: string, headers: Record<string, string>): void {
        const headerKeys = Object.keys(headers).sort().join(',');
        const hasAuthHeader = Boolean(headers.Authorization);
        console.log(`[VALIDATION][ALERT][HTTP] request method=${method} url=${url} header_keys=${headerKeys} authorization_present=${hasAuthHeader}`);
    }

    private async ensureAlertContainerReady(): Promise<void> {
        if (this.alertContainerInitialized) {
            return;
        }
        const alertAuthorization = await this.resolveAlertWriteAuthorizationHeader();
        const setupHeaders: Record<string, string> = {
            'Content-Type': 'text/turtle',
            'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        };
        if (alertAuthorization) {
            setupHeaders.Authorization = alertAuthorization;
        }
        this.logAlertHttpRequestTrace(AggregatorInstantiator.ALERT_CONTAINER, 'PUT', setupHeaders);
        const setupResponse = await fetch(AggregatorInstantiator.ALERT_CONTAINER, {
            method: 'PUT',
            headers: setupHeaders,
            body: ''
        });
        console.log(`[VALIDATION][ALERT] container_setup_request_sent url=${AggregatorInstantiator.ALERT_CONTAINER}`);
        console.log(`[VALIDATION][ALERT] container_setup_response_received status=${setupResponse.status}`);
        this.alertContainerInitialized = setupResponse.ok || setupResponse.status === 409 || setupResponse.status === 412;
    }

    private async materializeLowSpo2Alert(sourceEventUri: string | undefined, spo2Value: number): Promise<void> {
        await this.ensureAlertContainerReady();
        const eventId = sourceEventUri ?? 'unknown';
        console.log(`[MEASURE][ALERT] write_start timestamp=${new Date().toISOString()} event_id=${eventId}`);
        const processingTimestamp = new Date().toISOString();
        const sourcePart = sourceEventUri && sourceEventUri.startsWith('http')
            ? `<${sourceEventUri}>`
            : `"${(sourceEventUri ?? 'unknown').replace(/"/g, '\\"')}"`;
        const alertBody = `@prefix alert: <${AggregatorInstantiator.ALERT_PREFIX}> .
@prefix xsd: <${AggregatorInstantiator.XSD_PREFIX}> .

<> a alert:LowValueDetected ;
   alert:sourceEvent ${sourcePart} ;
   alert:observedValue "${spo2Value}"^^xsd:decimal ;
   alert:processedAt "${processingTimestamp}"^^xsd:dateTime .
`;
        const slug = `low-spo2-${hash_string_md5(`${sourceEventUri ?? 'unknown'}|${spo2Value}`)}`;
        const alertAuthorization = await this.resolveAlertWriteAuthorizationHeader();
        const writeHeaders: Record<string, string> = {
            'Content-Type': 'text/turtle',
            'Slug': slug,
        };
        if (alertAuthorization) {
            writeHeaders.Authorization = alertAuthorization;
        }
        let tokenExpired = false;
        if (alertAuthorization) {
            const bearerToken = alertAuthorization.replace(/^Bearer\s+/i, '');
            const tokenParts = bearerToken.split('.');
            if (tokenParts.length === 3) {
                try {
                    const payloadJson = Buffer.from(tokenParts[1], 'base64url').toString('utf8');
                    const payload = JSON.parse(payloadJson) as { exp?: number };
                    if (payload.exp) {
                        tokenExpired = Date.now() >= payload.exp * 1000;
                    }
                } catch {
                    tokenExpired = false;
                }
            }
        }
        this.logAlertHttpRequestTrace(AggregatorInstantiator.ALERT_CONTAINER, 'POST', writeHeaders);
        console.log(`[VALIDATION][ALERT] write_request_sent event_id=${eventId} timestamp=${new Date().toISOString()}`);
        console.log(`[VALIDATION][ALERT][WRITE_REQUEST] event_id=${eventId} url=${AggregatorInstantiator.ALERT_CONTAINER} method=POST header_keys=${Object.keys(writeHeaders).sort().join(',')} authorization_present=${Boolean(writeHeaders.Authorization)} token_expired=${tokenExpired}`);
        try {
            const writeResponse = await fetch(AggregatorInstantiator.ALERT_CONTAINER, {
                method: 'POST',
                headers: writeHeaders,
                body: alertBody,
            });
            console.log(`[VALIDATION][ALERT] write_response_received event_id=${eventId} timestamp=${new Date().toISOString()} status=${writeResponse.status}`);
            const responseBody = await writeResponse.text().catch(() => '');
            const locationHeader = writeResponse.headers.get('location') ?? '';
            const headerPairs = Array.from(writeResponse.headers.entries()).map(([key, value]) => `${key}:${value}`);
            console.log(`[VALIDATION][ALERT][WRITE_RESPONSE] event_id=${eventId} status=${writeResponse.status} status_text=${writeResponse.statusText} location=${locationHeader || 'none'} headers=${JSON.stringify(headerPairs)} body=${JSON.stringify(responseBody)}`);
            const writtenResource = locationHeader || null;
            if (writeResponse.ok && writtenResource) {
                console.log(`[MEASURE][ALERT] write_success timestamp=${new Date().toISOString()} event_id=${eventId} resource=${writtenResource}`);
            } else if (writeResponse.ok) {
                console.log(`[MEASURE][ALERT] write_success timestamp=${new Date().toISOString()} event_id=${eventId} resource=${AggregatorInstantiator.ALERT_CONTAINER}`);
            } else {
                console.log(`[VALIDATION][ALERT][WRITE_ERROR] event_id=${eventId} status=${writeResponse.status} location=${locationHeader || 'none'} message=${JSON.stringify(responseBody)}`);
            }
        } catch (error) {
            const err = error as Error;
            console.log(`[VALIDATION][ALERT] write_error event_id=${eventId} timestamp=${new Date().toISOString()}`);
            console.log(`[VALIDATION][ALERT][WRITE_ERROR] event_id=${eventId} message=${JSON.stringify(err.message)} stack=${JSON.stringify(err.stack ?? '')}`);
        }
    }

}

type QueryExecutionAuditContext = {
    queryId: string;
    actorWebId: string;
    benchmarkTiming?: BenchmarkTimingContext;
    onDataAccess?: (resource: string) => void;
    onExecutionFailed?: (errorMessage: string) => void;
}
