import { RSPQLParser } from "../parsers/RSPQLParser";
import { Logger, ILogObj } from "tslog";
import { AggregatorInstantiator } from "../aggregator/AggregatorInstantiator";
import { is_equivalent } from "rspql-query-equivalence";
import { WriteLockArray } from "../../utils/query-registry/Util";
import { hash_string_md5 } from "../../utils/Util";
import * as fs from 'fs';
import * as path from 'path';
const websocketConnection = require('websocket').connection;
const WebSocketClient = require('websocket').client;
/**
 * The AuditLoggedQueryService class is responsible for registering, executing and storing the queries.
 * @class AuditLoggedQueryService
 */
export class AuditLoggedQueryService {
    registered_queries: WriteLockArray<string>;
    executed_queries: WriteLockArray<string>;
    future_queries: string[];
    executing_queries: WriteLockArray<string>;
    query_count: number;
    parser: RSPQLParser;
    logger: Logger<ILogObj>;
    query_hash_map: Map<string, string>;
    static connection: typeof websocketConnection;
    public static client: any = new WebSocketClient();
    private logFilePath = path.resolve(__dirname, '../../../../query_audit_log.json');

    /**
     * Creates an instance of AuditLoggedQueryService.
     * @memberof AuditLoggedQueryService
     */
    constructor() {
        /**
         * Map of registered queries which are the queries without any analysis by the AuditLoggedQueryService but only registered.  
         */
        this.registered_queries = new WriteLockArray<string>();
        /**
         * Array of executing queries which were unique as compared to all the existing queries in the AuditLoggedQueryService. 
         */
        this.executing_queries = new WriteLockArray<string>();
        this.executed_queries = new WriteLockArray<string>();
        this.query_hash_map = new Map();
        this.future_queries = new Array<string>();
        this.query_count = 0;
        this.parser = new RSPQLParser();
        this.logger = new Logger();
    }
    /**
     *  Register a query in the AuditLoggedQueryService.
     * @param {string} rspql_query - The RSPQL query to be registered.
     * @param {AuditLoggedQueryService} query_registry - The AuditLoggedQueryService object.
     * @param {number} from_timestamp - The timestamp from where the query is to be executed.
     * @param {number} to_timestamp - The timestamp to where the query is to be executed.
     * @param {any} logger - The logger object.
     * @param {string} query_type - The type of the query (either 'historical+live' or just 'live').
     * @param {any} event_emitter - The event emitter object.
     * @returns {Promise<boolean>} - Returns true if the query is unique, otherwise false.
     * @memberof AuditLoggedQueryService
     */
    async register_query(rspql_query: string, rules: string, query_registry: AuditLoggedQueryService, from_timestamp: number, to_timestamp: number, logger: any, query_type: any, event_emitter: any): Promise<boolean> {
        if (await query_registry.add_query_in_registry(rspql_query, logger)) {
            /*
            The query is not already executing or computed ; it is unique. So, just compute it and send it via the websocket.
            */
            logger.info({}, 'query_is_unique');
            new AggregatorInstantiator(rspql_query, rules, from_timestamp, to_timestamp, logger, query_type, event_emitter);

            const query_id = hash_string_md5(rspql_query + from_timestamp + to_timestamp);
            const logEntry = {
                query_id,
                query: rspql_query,
                registered_by: 'healthcare-worker',
                timestamp: new Date().toISOString(),
                similar_queries_id: [],
                access_log: []
            };
            this.logQueryRegistration(logEntry);
            this.auditQueryLog();
            return true;
        }
        else {
            /*
            The query is already computed and stored in the Solid Stream Aggregator's Solid Pod. So, read from there and send via a websocket.
            */
            logger.info({}, 'query_is_not_unique');
            this.logger.debug(`The query you have registered is already executing.`);
            return false;
        }

    }

    /**
     * Add a query to the registry.
     * @param {string} rspql_query - The RSPQL query to be added.
     * @param {any} logger - The logger object.
     * @returns {Promise<boolean>} - Returns true if the query is unique, otherwise false.
     * @memberof AuditLoggedQueryService
     */
    async add_query_in_registry(rspql_query: string, logger: any): Promise<boolean> {
        await this.registered_queries.addItem(rspql_query);
        if (this.checkUniqueQuery(rspql_query, logger)) {
            /*
            The query you have registered is already executing.
            */
            return false;
        }
        else {
            /*
            The query you have registered is not already executing.
            */
            this.add_to_executing_queries(rspql_query);
            return true;
        }
    }

    /**
     * Add a query to the executing queries.
     * @param {string} query - The query to be added.
     * @returns {Promise<void>} - Returns nothing.
     * @memberof AuditLoggedQueryService
     */
    async add_to_executing_queries(query: string): Promise<void> {
        this.executing_queries.addItem(query);
    }

    /**
     * Checking if the query is unique or if it is isomorphic with an already executing query.
     * @param {string} query - The query to be checked.
     * @param {any} logger - The logger object.
     * @returns {boolean} - Returns true if the query is unique, otherwise false.
     * @memberof AuditLoggedQueryService
     */
    checkUniqueQuery(query: string, logger: any): boolean {
        const query_hashed = hash_string_md5(query);
        const registered_queries = this.get_registered_queries();
        const array_length = registered_queries.get_length();
        if (array_length > 1) {
            for (let i = 0; i < array_length; i++) {
                return is_equivalent(query, registered_queries.get_item(i));
            }
        }
        if (array_length === 0) {
            logger.info({ query_hashed }, 'array_length_is_zero');
        }
        logger.info({ query_hashed }, 'isomorphic_check_done')
        return false;
    }

    /**
     * Get the query registry length.
     * @returns {number} - The length of the query registry.
     * @memberof AuditLoggedQueryService
     */
    get_query_registry_length() {
        return this.registered_queries.get_length();
    }

    /**
     * Delete all the queries from the registry.
     * @returns {boolean} - Returns true if the queries are deleted, otherwise false.
     * @memberof AuditLoggedQueryService
     */
    public delete_all_queries_from_the_registry() {
        this.registered_queries.delete_all_items();
        const registered_queries = this.get_registered_queries();
        if (registered_queries.getArrayCopy().length === 0) {
            this.logger.info('query_registry_cleared');
            return true;
        }
        else {
            this.logger.error('query_registry_not_cleared');
            return false;
        }
    }

    /**
     * Log a query registration to the audit log file.
     */
    logQueryRegistration(entry: QueryLogEntry) {
        let logs: QueryLogEntry[] = [];
        if (fs.existsSync(this.logFilePath)) {
            try {
                const data = fs.readFileSync(this.logFilePath, 'utf-8');
                logs = JSON.parse(data);
            } catch (e) {
                logs = [];
            }
        }
        logs.push(entry);
        fs.writeFileSync(this.logFilePath, JSON.stringify(logs, null, 2));
    }

    /**
     * Log an access event for a query to the audit log file.
     */
    logAccess(queryId: string, access: { user: string; timestamp: string; data_accessed: string }) {
        let logs: QueryLogEntry[] = [];
        if (fs.existsSync(this.logFilePath)) {
            try {
                const data = fs.readFileSync(this.logFilePath, 'utf-8');
                logs = JSON.parse(data);
            } catch (e) {
                logs = [];
            }
        }
        const log = logs.find(q => q.query_id === queryId);
        if (log) {
            log.access_log.push(access);
            fs.writeFileSync(this.logFilePath, JSON.stringify(logs, null, 2));
        }
    }

    public auditQueryLog() {
        // You can call logQueryRegistration or logAccess here as needed
    }

    /**
     * Get the executing queries.
     * @returns {WriteLockArray<string>} - The executing queries.
     * @memberof AuditLoggedQueryService
     */
    get_executing_queries() {
        return this.executing_queries;
    }


    /** 
     * Get the registered queries.
     * @returns {WriteLockArray<string>} - The registered queries.
     * @memberof AuditLoggedQueryService
     */
    get_registered_queries() {
        return this.registered_queries;
    }


    /**
     * Send a message to the server.
     * @static
     * @param {string} message - The message to be sent.
     * @memberof AuditLoggedQueryService
     */
    static send_to_server(message: string) {
        if (this.connection.connected) {
            this.connection.sendUTF(message);
        }
        else {
            this.connect_with_server('ws://localhost:8080').then(() => {
                console.log(`The connection with the websocket server was not established. It is now established.`);
            });
        }
    }

    /**
     * Connect with the Websocket server.
     * @static
     * @param {string} websocketURL - The URL of the websocket server.
     * @memberof AuditLoggedQueryService
     */
    static async connect_with_server(websocketURL: string) {
        this.client.connect(websocketURL, 'solid-stream-aggregator-protocol');
        this.client.on('connect', (connection: typeof websocketConnection) => {
            AuditLoggedQueryService.connection = connection;
        });
        this.client.setMaxListeners(Infinity);
        this.client.on('connectFailed', (error: any) => {
            console.log('Connect Error: ' + error.toString());
        });
    }

}

interface QueryLogEntry {
  query_id: string;
  query: string;
  registered_by: string;
  timestamp: string;
  similar_queries_id: string[];
  access_log: Array<{
    user: string;
    timestamp: string;
    data_accessed: string;
  }>;
}