import { Parser } from "n3";
import * as WebSocket from 'websocket';
import { EventEmitter } from "events";
import * as CONFIG from '../config/ldes_properties.json';
import { LDESPublisher } from "../service/publishing-stream-to-pod/LDESPublisher";
import { find_relevant_streams, hash_string_md5 } from "../utils/Util";
import { QueryHandler } from "./QueryHandler";
import { RSPQLParser } from "../service/parsers/RSPQLParser";
import { AuditLoggedQueryService } from "../service/query-registry/AuditLoggedQueryService";
import { TokenManagerService } from "../service/authorization/TokenManagerService";
import { AggregationFocusExtractor } from "../service/parsers/AggregationFocusExtractor";
import { getAuthenticatedSession } from "@treecg/versionawareldesinldp";
import * as AGG_CONFIG from '../config/pod_credentials.json';
import * as dotenv from 'dotenv';
import { ReuseTokenUMAFetcher } from "../service/authorization/ReuseTokenUMAFetcher";
import { ContinuousAnomalyMonitoringService } from "../service/reasoner/ContinuousAnomalyMonitoringService";
dotenv.config();

/**
 * Class for handling the Websocket server.
 * @class WebSocketHandler
 */
export class WebSocketHandler {

    private aggregation_resource_list: any[];
    private readonly aggregation_resource_list_batch_size: number = CONFIG.BUCKET_SIZE;
    private connections: Map<string, WebSocket[]>;
    private parser: RSPQLParser;
    private n3_parser: Parser;
    private token_manager: TokenManagerService;
    public websocket_server: WebSocket.server;
    public event_emitter: EventEmitter;
    public uma_fetcher: ReuseTokenUMAFetcher;
    public aggregation_publisher: LDESPublisher;
    public logger: any;
    private query_registry: AuditLoggedQueryService;
    /**
     * Creates an instance of WebSocketHandler.
     * @param {WebSocket.server} websocket_server - The Websocket server.
     * @param {EventEmitter} event_emitter - The event emitter.
     * @param {LDESPublisher} aggregation_publisher - The LDES Publisher class instance.
     * @param {*} logger - The logger object.
     * @memberof WebSocketHandler
     */
    constructor(websocket_server: WebSocket.server, event_emitter: EventEmitter, aggregation_publisher: LDESPublisher, logger: any) {
        this.aggregation_resource_list = [];
        this.logger = logger;
        this.websocket_server = websocket_server;
        this.event_emitter = event_emitter;
        this.token_manager = TokenManagerService.getInstance();
        this.uma_fetcher = new ReuseTokenUMAFetcher({
            token: "http://n063-04b.wall2.ilabt.iminds.be/replayer#me",
            token_format: "urn:solidlab:uma:claims:formats:webid"
        });
        this.aggregation_publisher = aggregation_publisher;
        this.connections = new Map<string, WebSocket[]>();
        this.parser = new RSPQLParser();
        this.query_registry = new AuditLoggedQueryService();
        this.n3_parser = new Parser({ format: 'N-Triples' });
        this.logger.info({}, 'websocket_handler_initialized');
    }

    /**
     * Handle the Websocket server.
     * It retrieves the query from the client and processes it.
     * It also sends the result to the client.
     * It also stores the aggregation event in the Solid Pod of the Solid Stream Aggregator.
     * @memberof WebSocketHandler
     */
    public handle_wss() {
        // TODO: find the type of the request object
        console.log(`Handling the websocket server.`);
        this.logger.info({}, 'handling_websocket_server');
        this.websocket_server.on('connect', (request: any) => {
            console.log(`Connection received from ${request.remoteAddress}`);
        });
        this.websocket_server.on('request', async (request: any) => {
            const connection = request.accept('solid-stream-aggregator-protocol', request.origin);
            connection.on('message', async (message: WebSocket.Message) => {
                console.log(`Message received from ${connection.remoteAddress}`);
                if (message.type === 'utf8') {
                    const message_utf8 = message.utf8Data;
                    const ws_message = JSON.parse(message_utf8);
                    if (Object.keys(ws_message).includes('query') && Object.keys(ws_message).includes('rules')) {
                        this.logger.info({ query: ws_message.query }, `new_query_received_from_client_ws`);
                        this.logger.info({ rules: ws_message.rules }, `rule_received_from_client_ws`);
                        const query_type = ws_message.type;
                        if (query_type === 'historical+live' || query_type === 'live') {
                            this.logger.info({}, `query_preprocessing_started`);
                            const { ldes_query, query_hashed, width } = await this.preprocess_query(ws_message.query);
                            this.logger.info({ query_id: query_hashed }, `query_preprocessed`);
                            const rules = ws_message.rules;
                            console.log(rules);
                            const monitoringService = ContinuousAnomalyMonitoringService.getInstance(rules);
                            const streams = this.return_streams(ldes_query)
                            this.set_connections(query_hashed, connection);
                            await this.authorizeDerivedResource(streams);
                            this.process_query(ldes_query, rules, width, query_type, this.event_emitter, this.logger);
                        }
                        else {
                            throw new Error(`The type of Query is not supported/handled. The type of query is: ${ws_message.type}`);
                        }
                    }
                    else if (Object.keys(ws_message).includes('aggregation_event')) {
                        this.logger.info({ query_id: ws_message.query_hash }, `aggregation_event_received_now_publishing_to_client_ws`);
                        const query_hash = ws_message.query_hash;
                        for (const [query, connections] of this.connections) {
                            if (query === query_hash) {
                                for (const connection of connections) {
                                    connection.send(JSON.stringify(ws_message));
                                }
                            }
                        }
                    }
                    else if (Object.keys(ws_message).includes('status')) {
                        const query_hash = ws_message.query_hash;
                        for (const [query, connections] of this.connections) {
                            if (query === query_hash) {
                                for (const connection of connections) {
                                    connection.send(JSON.stringify(ws_message));
                                }
                            }
                        }
                    }
                    else {
                        throw new Error('Unknown message, not handled.');
                    }
                }
            });
            connection.on('close', (reason_code: string, description: string) => {
                this.logger.debug(`Connection closed from ${connection.remoteAddress}: ${reason_code} - ${description}`);
            });
            connection.on('error', (error: Error) => {
                this.logger.debug(`Error in connection from ${connection.remoteAddress}: ${error}`);
            });
        });
        this.client_response_publisher();
        this.aggregation_event_publisher();
    }

    /**
     * Send the aggregation event to the client's Websocket channel.
     * @memberof WebSocketHandler
     */
    public async client_response_publisher() {
        this.event_emitter.on('aggregation_event', (object: string) => {
            const event = JSON.parse(object)
            const query_id = event.query_hash;
            const connections = this.connections.get(query_id);
            if (connections !== undefined) {
                for (const connection of connections) {
                    connection.send(event.aggregation_event);
                }
            }
        });
    }
    /**
     * Publish the aggregation event to the Solid Pod of the Solid Stream Aggregator.
     * @param {*} aggregation_event - The aggregation event to be published.
     * @param {LDESPublisher} aggregation_publisher - The LDES Publisher class instance.
     * @memberof WebSocketHandler
     */
    public publish_aggregation_event(aggregation_event: any, aggregation_publisher: LDESPublisher) {
        let zeroLengthDuration: number = 0;
        let intervalId: any | null = null;
        const event_quad: any = this.n3_parser.parse(aggregation_event.aggregation_event);
        this.aggregation_resource_list.push(event_quad);

        if (this.aggregation_resource_list.length === this.aggregation_resource_list_batch_size) {
            this.logger.info({ query_id: aggregation_event.query_hash }, `publishing_aggregation_event_bucket`);
            aggregation_publisher.publish(
                this.aggregation_resource_list,
                aggregation_event.aggregation_window_from,
                aggregation_event.aggregation_window_to
            );
            this.aggregation_resource_list = [];
        }

        if (this.aggregation_resource_list.length === 0) {
            this.logger.debug(`No aggregation events to publish.`);
        }

        const checkInterval: number = 500; // Check every 500 milliseconds
        intervalId = setInterval(() => {
            if (this.aggregation_resource_list.length === 0) {
                zeroLengthDuration += 500; // Increment the duration by the check interval

                if (zeroLengthDuration >= 5000) {
                    this.logger.info({ query_id: aggregation_event.query_hash }, `aggregation_publishing_has_been_done`);
                    clearInterval(intervalId!); // Clear the interval when threshold reached
                    zeroLengthDuration = 0; // Reset the duration
                }
            } else {
                zeroLengthDuration = 0; // Reset the duration when events are present
            }
        }, checkInterval);
    }
    /**
     * Publish the aggregation event to the Solid Pod of the Solid Stream Aggregator.
     * @memberof WebSocketHandler
     */
    public aggregation_event_publisher() {
        this.event_emitter.on('aggregation_event', async (object: string) => {
            const parser = new Parser({ format: 'N-Triples' });
            const aggregation_event = JSON.parse(object)
            const event_quad: any = parser.parse(aggregation_event.aggregation_event);
            this.aggregation_resource_list.push(event_quad);
            if (this.aggregation_resource_list.length == this.aggregation_resource_list_batch_size) {
                await this.aggregation_publisher.publish(this.aggregation_resource_list, aggregation_event.aggregation_window_from, aggregation_event.aggregation_window_to);
                this.aggregation_resource_list = [];
            }
            if (this.aggregation_resource_list.length == 0) {
                this.logger.debug(`No aggregation events to publish.`);
                this.aggregation_publisher.update_latest_inbox(this.aggregation_publisher.lilURL);
            }
        });

        this.event_emitter.on('close', () => {
            this.logger.debug(`Closing the aggregation event publisher.`);
        });

        this.event_emitter.on('error', (error: Error) => {
            this.logger.debug(`Error in aggregation event publisher: ${error}`);
            this.event_emitter.on('error', (error: Error) => {
                this.logger.debug(`Error in aggregation event publisher: ${error}`);
            });

            this.event_emitter.on('end', () => {
                this.logger.debug(`End of aggregation event publisher.`);
            });
        });
    }
    /**
     * Send the result to the client for the given query.
     * @param {string} query_id - The id of the query.
     * @param {*} result - The result to be sent (the aggregation result).
     * @memberof WebSocketHandler
     */
    public send_result_to_client(query_id: string, result: any) {
        const websocket_clients = this.connections.get(query_id);
        if (websocket_clients !== undefined) {
            for (const client of websocket_clients) {
                client.send(JSON.stringify(result));
            }
        }
        else {
            console.log(`There is no websocket connection available for the query`);
            this.logger.debug(`No connection found for query id: ${query_id}`);
        }
    }
    /**
     * Process the query and send the result to the client.
     * @param {string} query - The query to be processed (RSP-QL query).
     * @param {number} width - The width of the window to be processed.
     * @param {string} query_type - The type of the query (historical+live or live).
     * @param {EventEmitter} event_emitter - The event emitter object.
     * @memberof WebSocketHandler
     */
    public process_query(query: string, rules: string, width: number, query_type: string, event_emitter: EventEmitter, logger: any) {
        QueryHandler.handle_ws_query(query, rules, width, this.query_registry, this.logger, this.connections, query_type, event_emitter);
    }

    /**
     * Preprocess the query to find the relevant LDES stream from the Type Index of the Solid Pod.
     * @param {string} query - The query to be preprocessed which was received from the client.
     * @returns {Promise<{ ldes_query: string, query_hashed: string, width: number }>} - The preprocessed query (which now contains the LDES stream instead of just the pod), the hashed query and the width of the window.
     * @memberof WebSocketHandler
     */
    public async preprocess_query(query: string): Promise<{ ldes_query: string, query_hashed: string, width: number }> {
        const parsed = this.parser.parse(query);
        const pod_url = parsed.s2r[0].stream_name;
        const ldes_query = query.replace(pod_url, pod_url);
        const width = parsed.s2r[0].width;
        const query_hashed = hash_string_md5(ldes_query);
        return { ldes_query, query_hashed, width };
    }
    /**
     * Set the connections for the given query.
     * @param {string} query_hashed - The hashed query.
     * @param {WebSocket} connection - The Websocket connection to be set for the query (to be associated with the query).
     * @returns {void} - Nothing, just sets the connection for the query in the connections map.
     * @memberof WebSocketHandler
     */
    public set_connections(query_hashed: string, connection: WebSocket): void {
        if (!this.connections.has(query_hashed)) {
            this.connections.set(query_hashed, [connection]);
        }
        else {
            const connections = this.connections.get(query_hashed);
            if (connections !== undefined) {
                connections.push(connection);
                this.connections.set(query_hashed, connections);
            }
        }
        this.logger.info({ query_id: query_hashed }, `websocket_connection_set_for_query`);
    }

    public async preAuthorize(resource: string, method: string, headers: HeadersInit = {}, body?: string): Promise<void> {
        if (method === undefined) {
            console.log(`The method is not defined. The default method is set to POST.`);
            method = "POST"
        }
        console.log(`[Fetcher] Pre-authorizing resource: ${resource} with method: ${method}`);

        const requestInit: RequestInit = {
            method,
            headers,
        };

        if (body) {
            requestInit.body = body;
        }

        await this.uma_fetcher.fetch(resource, requestInit);
    }


    public getResourceStreamAndWebIdFromQuery(rspql_query: string) {
        const stream_match_regex = /FROM NAMED WINDOW\s+[^ ]+\s+ON STREAM\s+<([^>]+)>/;
        const stream_match = rspql_query.match(stream_match_regex);

        if (stream_match !== null) {
            const stream_location = stream_match[1]; // Extracts the stream URL
            const webID = stream_location.replace(/\/[^/]+\/?$/, '/profile/card#me');
            return { stream_location, webID };
        }
        else {
            throw new Error("The stream is not found in the query.");
        }
    }

    public return_streams(rspql_query: string): string[] {
        const parser = new RSPQLParser();
        const parsed = parser.parse(rspql_query);
        return parsed.s2r.map((stream: any) => stream.stream_name);
    }

    public async authorizeFetch(containers_to_publish: string[]) {
        await Promise.all(
            containers_to_publish.map(container =>
                this.preAuthorize(container, 'GET')
            )
        ).then(() => {
            containers_to_publish.map(container => {
                this.preAuthorize(container, 'POST', {
                    'Content-Type': 'text/turtle',
                }, `<https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <http://rdfs.org/ns/void#inDataset> <https://dahcc.idlab.ugent.be/Protego/_participant1> .
<https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <https://saref.etsi.org/core/measurementMadeBy> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/E4.A03846.Accelerometer> .
<https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <http://purl.org/dc/terms/isVersionOf> <https://saref.etsi.org/core/Measurement> .
<https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <https://saref.etsi.org/core/relatesToProperty> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.acceleration.x> .
<https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <https://saref.etsi.org/core/hasTimestamp> "2025-05-05T12:57:59.166Z" .
<https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <https://saref.etsi.org/core/hasValue> "-22.0"^^<http://www.w3.org/2001/XMLSchema#float> .
`);
            })
        });
    }

    public async authorizeDerivedResource(containers_to_publish: string[]) {
        const derivedResources: string[] = containers_to_publish.map(url => {
            const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
            const parts = trimmed.split('/');
            const lastSegment = parts.pop();
            parts.push('derived', lastSegment!);
            return parts.join('/');
        });
    
        console.log(derivedResources);
        console.log(containers_to_publish);
    
        await Promise.all(
            derivedResources.map(container => {
                return this.preAuthorize(container, 'GET');
            })
        );
    }
    
}