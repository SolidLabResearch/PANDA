import { createServer, ServerResponse, IncomingMessage, Server } from "http";
import { GETHandler } from "./GETHandler";
import { LDESPublisher } from "../service/publishing-stream-to-pod/LDESPublisher";
import { AuditLoggedQueryService } from "../service/query-registry/AuditLoggedQueryService";
import { WebSocketHandler } from "./WebSocketHandler";
import * as websocket from 'websocket';
const EventEmitter = require('events');
import { ReuseTokenUMAFetcher } from "../service/authorization/ReuseTokenUMAFetcher";
import { getUmaClaim } from "../config/UmaClaim";
import { resolveNotificationTopic } from "./NotificationTopicResolver";

/**
 * Class for the HTTP Server.
 * @class HTTPServer
 */
export class HTTPServer {
    private readonly http_server: Server;
    public solid_server_url: string;
    public logger: any;
    public dynamic_endpoints: { [key: string]: boolean };
    public query_registry: any;
    public websocket_server: any;
    public uma_fetcher: any;
    public aggregation_publisher: any;
    public websocket_handler: any;
    public event_emitter: any;
    /**
     * Creates an instance of HTTPServer.
     * @param {number} http_port - The port on which the HTTP server is to be started.
     * @param {string} solid_server_url - The URL of the Solid Server.
     * @param {*} logger - The logger object.
     * @memberof HTTPServer
     */
    constructor(http_port: number, solid_server_url: string, logger: any) {
        this.solid_server_url = solid_server_url;
        this.dynamic_endpoints = {};
        this.uma_fetcher = new ReuseTokenUMAFetcher(getUmaClaim());
        this.http_server = createServer(this.request_handler.bind(this)).listen(http_port);
        this.logger = logger;
        this.websocket_server = new websocket.server({
            httpServer: this.http_server
        });
        this.http_server.keepAliveTimeout = 6000;
        this.aggregation_publisher = new LDESPublisher();
        this.event_emitter = new EventEmitter();
        this.websocket_handler = new WebSocketHandler(this.websocket_server, this.event_emitter, this.aggregation_publisher, this.logger);
        this.query_registry = this.websocket_handler.get_query_registry();
        this.websocket_handler.handle_wss();
        // Commenting out the aggregation event publisher as we are not storing the resultant LDES stream in a Solid Pod.
        // this.websocket_handler.aggregation_event_publisher();
        this.logger.info({}, 'http_server_started');
        console.log(`HTTP Server started on port ${http_port} and the process id is ${process.pid}`);
    }
    /**
     * Handle the request from the client.
     * Handles the GET and the POST requests from the client.
     * @private
     * @param {IncomingMessage} req - The request from the client.
     * @param {ServerResponse} res - The response to the client.
     * @memberof HTTPServer
     */
    private request_handler(req: IncomingMessage, res: ServerResponse) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET');
        let body: string = '';

        switch (req.method) {
            case "GET":
                this.logger.info({}, 'http_get_request_received');
                GETHandler.handle(req, res, this.query_registry);
                res.end();
                break;
            case "POST":
                req.on('data', (chunk: Buffer) => {
                    body = body + chunk.toString();
                });
                req.on('end', async () => {
                    try {
                        const webhook_notification_data = JSON.parse(body);
                        this.logger.info({}, 'webhook_notification_data_received');

                        if (webhook_notification_data.type === 'Add') {
                            this.logger.info({}, 'webhook_notification_received');
                            const target = typeof webhook_notification_data.target === 'string' ? webhook_notification_data.target : undefined;
                            const topic = resolveNotificationTopic(webhook_notification_data, target);
                            const fetchTarget = target || topic;

                            if (!fetchTarget || !topic) {
                                this.logger.error({}, 'webhook_notification_missing_target_or_topic');
                                return;
                            }

                            if (typeof webhook_notification_data.data === 'string' && webhook_notification_data.data.length > 0) {
                                const latest_event = webhook_notification_data.data;
                                this.logger.info({ topic, fetch_target: fetchTarget }, 'webhook_notification_emitting_topic');
                                this.event_emitter.emit(topic, latest_event);
                                this.logger.info({}, 'webhook_notification_processed_and_emitted');
                            } else {
                                const latest_event_response = await this.uma_fetcher.fetch(fetchTarget, {
                                    method: 'GET',
                                    headers: {
                                        'Accept': 'text/turtle'
                                    }
                                });

                                if (latest_event_response.ok) {
                                    const latest_event = await latest_event_response.text();
                                    this.logger.info({ topic, fetch_target: fetchTarget }, 'webhook_notification_emitting_topic');
                                    this.event_emitter.emit(topic, latest_event);
                                    this.logger.info({}, 'webhook_notification_processed_and_emitted');
                                } else {
                                    console.error(`Failed to fetch notified resource ${fetchTarget}. Status: ${latest_event_response.status}`);
                                    this.logger.warn({ topic, fetch_target: fetchTarget, status: latest_event_response.status }, 'webhook_notification_fetch_failed');
                                }
                            }
                        }
                    } catch (error: any) {
                        console.error(`Error while handling webhook notification: ${error?.message ?? String(error)}`);
                        this.logger.error({ error: error?.message ?? String(error) }, 'webhook_notification_processing_failed');
                    }
                });
                break;
            default:
                res.writeHead(405, { 'Content-Type': 'text/plain' });
                break;
        }

        if (req.method === 'OPTIONS') {
            res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'OPTIONS, GET',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Content-Length': 0
            });
        }
        res.end();
    }

    /**
     * Close the HTTP server.
     * @memberof HTTPServer
     */
    public close() {
        this.http_server.close();
        this.logger.info({}, 'http_server_closed');
    }

}
