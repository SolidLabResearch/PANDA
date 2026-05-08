import { storeToString } from "@treecg/versionawareldesinldp";
import { AuditLoggedQueryService, RegisterQueryResult } from "../service/query-registry/AuditLoggedQueryService";
import { AggregationDispatcher } from "../service/result-dispatcher/AggregationDispatcher";
import { RequestBody } from "../utils/Types";
import { hash_string_md5 } from "../utils/Util";
import { BenchmarkTimingContext } from "../utils/benchmark/BenchmarkTiming";
const websocketConnection = require('websocket').connection;
const WebSocketClient = require('websocket').client;
const N3 = require('n3');
/**
 * Class for handling the POST request from the client.
 * @class QueryHandler
 */
export class QueryHandler {
    static connection: typeof websocketConnection;
    public static client: any;
    static request_body: RequestBody;
    /**
     * Creates an instance of QueryHandler.
     * @memberof QueryHandler
     */
    constructor() {
        QueryHandler.connection = websocketConnection;
        QueryHandler.client = new WebSocketClient();
    }

    /**
     * Handle the Websocket query from the client.
     * It checks if the query is unique and if it is, then it registers the query in the AuditLoggedQueryService and if it is not, then it sends the aggregated events to the client.
     * The non unique query is the query that is already registered in the AuditLoggedQueryService, and it uses the Function Ontology Description from the Solid Stream Aggregator's Solid Pod
     * To get the aggregated events and send them to the client.
     * @static
     * @param {string} query - The query to be handled (in RSPQL).
     * @param {string} rules - The rules.
     * @param {number} width - The width of the window.
     * @param {AuditLoggedQueryService} query_registry - The AuditLoggedQueryService object.
     * @param {*} logger - The logger object.
     * @param {any} websocket_connections - The Websocket connections.
     * @param {string} query_type - The type of the query (either historical+live or live).
     * @param {any} event_emitter - The event emitter object.
     * @memberof QueryHandler
     */
    public static async handle_ws_query(query: string, rules: string, width: number, query_registry: AuditLoggedQueryService, logger: any, websocket_connections: any, query_type: string, event_emitter: any, actor_webid: string = 'unknown-actor', authorization_scope: string[] = [], benchmarkTiming?: BenchmarkTimingContext): Promise<RegisterQueryResult | undefined> {
        const aggregation_dispatcher = new AggregationDispatcher(query);
        const to_timestamp = new Date().getTime(); // current time
        const from_timestamp = new Date(to_timestamp - (width)).getTime(); // latest seconds ago
        const query_hashed = hash_string_md5(query);
        try {
            const registration = await query_registry.register_query({
                rspql_query: query,
                rules,
                from_timestamp,
                to_timestamp,
                logger,
                query_type,
                event_emitter,
                actor_webid,
                authorization_scope,
                benchmarkTiming
            });

            if (registration.should_execute) {
                console.log(`The query is unique.`);
                logger.info({ query_id: registration.query_id }, `unique_query_registered`);
                return;
            }

            logger.info({ query_id: registration.query_id, reused_from_query_id: registration.reused_from_query_id }, `non_unique_query_registered`);
            for (const [registeredQueryHash, connections] of websocket_connections) {
                if (registeredQueryHash === query_hashed) {
                    for (const connection of connections) {
                        connection.send(JSON.stringify(`{
                            "type": "status",
                            "status": "duplicate_query",
                            "query_id": "${registration.query_id}",
                            "reused_from_query_id": "${registration.reused_from_query_id || ''}"
                        }`));
                        logger.info({ query_id: query_hashed }, `duplicate_query`);
                    }
                }
                else {
                    const aggregated_events_exist = await aggregation_dispatcher.if_aggregated_events_exist();
                    if (aggregated_events_exist) {
                        logger.info({ query_id: query_hashed }, 'aggregated_events_exist_for_query_in_aggregator_pod');
                        const aggregation_stream = await aggregation_dispatcher.dispatch_aggregated_events({});
                        aggregation_stream.on('data', async (data) => {
                            const store = new N3.Store(data.quads);
                            const aggregation_event = storeToString(store)
                            const object = {
                                query_hash: hash_string_md5(query),
                                aggregation_event: aggregation_event,
                            }
                            const object_string = JSON.stringify(object);
                            this.sendToServer(object_string);
                        });
                    }
                    else {
                        console.log(`The aggregated events do not exist.`);
                    }
                }
            }
        } catch (error: any) {
            logger.error({ query_id: query_hashed, error: error?.message ?? String(error) }, 'query_registration_failed');
        }
        return undefined;
    }
    /**
     * Connect with the Websocket server of the Solid Stream Aggregator.
     * @static
     * @param {string} wssURL - The URL of the Websocket server.
     * @memberof QueryHandler
     */
    static async connect_with_server(wssURL: string) {
        this.client.connect(wssURL, 'solid-stream-aggregator-protocol');
        this.client.on('connect', (connection: typeof websocketConnection) => {
            QueryHandler.connection = connection;
        });
        this.client.setMaxListeners(Infinity);
        this.client.on('connectFailed', (error: Error) => {
            console.log('Connect Error: ' + error.toString());
        });
    }
    /**
     * Send a message to the Websocket server of the Solid Stream Aggregator.
     * @static
     * @param {string} message - The message to be sent to the server.
     * @memberof QueryHandler
     */
    static sendToServer(message: string) {
        if (this.connection.connected) {
            this.connection.sendUTF(message);
        }
        else {
            this.connect_with_server('ws://localhost:8080/').then(() => {
                console.log(`The connection with the websocket server was not established. It is now established.`);
            });
        }
    }
}
