import { Logger, ILogObj } from "tslog";
import { AggregatorInstantiator } from "../aggregator/AggregatorInstantiator";
import { is_equivalent } from "rspql-query-equivalence";
import { WriteLockArray } from "../../utils/query-registry/Util";
import { hash_string_md5 } from "../../utils/Util";
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from "crypto";
const websocketConnection = require('websocket').connection;
const WebSocketClient = require('websocket').client;

export type QueryStatus = 'registered' | 'executing' | 'executed' | 'failed';

export interface AccessLogEntry {
    user: string;
    timestamp: string;
    data_accessed: string;
}

export interface QueryLogEntry {
    query_id: string;
    query: string;
    normalized_query: string;
    registered_by: string;
    timestamp: string;
    status: QueryStatus;
    similar_queries_id: string[];
    reuse_decision: 'executed_new' | 'reused_existing' | 'not_reused_actor_scope_mismatch';
    reused_from_query_id?: string;
    authorization_scope: string[];
    access_log: AccessLogEntry[];
}

export interface RegisterQueryInput {
    rspql_query: string;
    rules: string;
    from_timestamp: number;
    to_timestamp: number;
    logger: any;
    query_type: string;
    event_emitter: any;
    actor_webid: string;
    authorization_scope: string[];
}

export interface RegisterQueryResult {
    query_id: string;
    query_hash: string;
    should_execute: boolean;
    reused_from_query_id?: string;
    status: QueryStatus;
}

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
    logger: Logger<ILogObj>;
    static connection: typeof websocketConnection;
    public static client: any = new WebSocketClient();
    private readonly logFilePath = path.resolve(__dirname, '../../../../query_audit_log.json');

    /**
     * Creates an instance of AuditLoggedQueryService.
     * @memberof AuditLoggedQueryService
     */
    constructor() {
        this.registered_queries = new WriteLockArray<string>();
        this.executing_queries = new WriteLockArray<string>();
        this.executed_queries = new WriteLockArray<string>();
        this.future_queries = new Array<string>();
        this.query_count = 0;
        this.logger = new Logger();
    }

    /**
     * Normalize query text for deterministic similarity detection.
     * Rules: trim leading/trailing whitespace and collapse internal whitespace to a single space.
     */
    public normalize_query(query: string): string {
        return query.replace(/\s+/g, ' ').trim();
    }

    private normalize_scope(scope: string[]): string[] {
        return Array.from(new Set(scope.map((s) => s.trim()).filter((s) => s.length > 0))).sort();
    }

    private sameScope(left: string[], right: string[]): boolean {
        if (left.length !== right.length) {
            return false;
        }
        for (let i = 0; i < left.length; i++) {
            if (left[i] !== right[i]) {
                return false;
            }
        }
        return true;
    }

    private read_logs(): QueryLogEntry[] {
        if (!fs.existsSync(this.logFilePath)) {
            return [];
        }

        try {
            const data = fs.readFileSync(this.logFilePath, 'utf-8');
            const parsed = JSON.parse(data);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_e) {
            return [];
        }
    }

    private write_logs(logs: QueryLogEntry[]): void {
        fs.writeFileSync(this.logFilePath, JSON.stringify(logs, null, 2));
    }

    private update_log_entry(queryId: string, updater: (entry: QueryLogEntry) => QueryLogEntry): boolean {
        const logs = this.read_logs();
        const index = logs.findIndex((entry) => entry.query_id === queryId);
        if (index === -1) {
            return false;
        }

        logs[index] = updater(logs[index]);
        this.write_logs(logs);
        return true;
    }

    public get_query_log_by_id(queryId: string): QueryLogEntry | undefined {
        const logs = this.read_logs();
        return logs.find((entry) => entry.query_id === queryId);
    }

    public get_audit_log_entries(): QueryLogEntry[] {
        return this.read_logs();
    }

    /**
     * Register a query and decide if execution should happen now or can be safely reused.
     */
    public async register_query(input: RegisterQueryInput): Promise<RegisterQueryResult> {
        const normalizedQuery = this.normalize_query(input.rspql_query);
        const normalizedScope = this.normalize_scope(input.authorization_scope);
        const existingLogs = this.read_logs();
        const similarQueries = existingLogs.filter((entry) => {
            if (entry.normalized_query) {
                return entry.normalized_query === normalizedQuery;
            }
            return this.normalize_query(entry.query) === normalizedQuery;
        });

        const actorAndScopeMatch = similarQueries.find((entry) => {
            const scope = this.normalize_scope(entry.authorization_scope || []);
            return entry.registered_by === input.actor_webid && this.sameScope(scope, normalizedScope);
        });

        const query_id = randomUUID();
        const query_hash = this.compute_query_hash(input.rspql_query);

        // Live queries should always start a fresh execution so webhook subscriptions
        // are re-established in the current process.
        const isLiveQuery = input.query_type === 'live';
        const shouldReuse = !isLiveQuery
            && actorAndScopeMatch !== undefined
            && (actorAndScopeMatch.status === 'executing' || actorAndScopeMatch.status === 'executed');
        const reuse_decision = shouldReuse
            ? 'reused_existing'
            : (similarQueries.length > 0 ? 'not_reused_actor_scope_mismatch' : 'executed_new');

        const status: QueryStatus = shouldReuse ? actorAndScopeMatch!.status : 'registered';

        const logEntry: QueryLogEntry = {
            query_id,
            query: input.rspql_query,
            normalized_query: normalizedQuery,
            registered_by: input.actor_webid,
            timestamp: new Date().toISOString(),
            status,
            similar_queries_id: similarQueries.map((entry) => entry.query_id),
            reuse_decision,
            reused_from_query_id: actorAndScopeMatch?.query_id,
            authorization_scope: normalizedScope,
            access_log: []
        };

        this.logQueryRegistration(logEntry);
        await this.registered_queries.addItem(input.rspql_query);

        if (shouldReuse) {
            input.logger.info({ query_id, reused_from_query_id: actorAndScopeMatch!.query_id }, 'query_reused_existing_execution');
            return {
                query_id,
                query_hash,
                should_execute: false,
                reused_from_query_id: actorAndScopeMatch!.query_id,
                status: logEntry.status
            };
        }

        this.mark_query_status(query_id, 'executing');
        await this.add_to_executing_queries(input.rspql_query);

        try {
            new AggregatorInstantiator(
                input.rspql_query,
                input.rules,
                input.from_timestamp,
                input.to_timestamp,
                input.logger,
                input.query_type,
                input.event_emitter,
                {
                    queryId: query_id,
                    actorWebId: input.actor_webid,
                    onDataAccess: (resource: string) => {
                        this.logAccess(query_id, {
                            user: input.actor_webid,
                            timestamp: new Date().toISOString(),
                            data_accessed: resource
                        });
                    },
                    onExecutionFailed: (errorMessage: string) => {
                        input.logger.error({ query_id, error: errorMessage }, 'query_execution_failed');
                        this.mark_query_status(query_id, 'failed');
                    }
                }
            );

            input.logger.info({ query_id }, 'query_is_unique_and_executing');
            return {
                query_id,
                query_hash,
                should_execute: true,
                status: 'executing'
            };
        } catch (error: any) {
            this.mark_query_status(query_id, 'failed');
            input.logger.error({ query_id, error: error?.message ?? String(error) }, 'query_execution_failed');
            throw error;
        }
    }

    public compute_query_hash(query: string): string {
        return hash_string_md5(query);
    }

    /**
     * Backward-compatible uniqueness check based on semantic equivalence against registered queries.
     */
    checkUniqueQuery(query: string, logger: any): boolean {
        const registered_queries = this.get_registered_queries().getArrayCopy();
        if (registered_queries.length <= 1) {
            logger.info({}, 'isomorphic_check_done');
            return false;
        }

        const candidates = registered_queries.slice(0, -1);
        for (const registered_query of candidates) {
            if (is_equivalent(query, registered_query)) {
                logger.info({}, 'isomorphic_check_done');
                return true;
            }
        }

        logger.info({}, 'isomorphic_check_done');
        return false;
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
            return false;
        }
        await this.add_to_executing_queries(rspql_query);
        return true;
    }

    /**
     * Add a query to the executing queries.
     */
    async add_to_executing_queries(query: string): Promise<void> {
        await this.executing_queries.addItem(query);
    }

    public mark_query_status(queryId: string, status: QueryStatus): boolean {
        return this.update_log_entry(queryId, (entry) => ({ ...entry, status }));
    }

    public mark_query_status_by_hash(queryHash: string, status: QueryStatus): number {
        const logs = this.read_logs();
        let updatedCount = 0;

        const nextLogs = logs.map((entry) => {
            if (this.compute_query_hash(entry.query) === queryHash && entry.status !== 'failed') {
                updatedCount++;
                return { ...entry, status };
            }
            return entry;
        });

        if (updatedCount > 0) {
            this.write_logs(nextLogs);
        }

        return updatedCount;
    }

    /**
     * Delete all the queries from the registry.
     */
    public delete_all_queries_from_the_registry() {
        this.registered_queries.delete_all_items();
        const registered_queries = this.get_registered_queries();
        if (registered_queries.getArrayCopy().length === 0) {
            this.logger.info('query_registry_cleared');
            return true;
        }
        this.logger.error('query_registry_not_cleared');
        return false;
    }

    /**
     * Log a query registration to the audit log file.
     */
    logQueryRegistration(entry: QueryLogEntry) {
        const logs = this.read_logs();
        logs.push(entry);
        this.write_logs(logs);
    }

    /**
     * Log an access event for a query to the audit log file.
     */
    logAccess(queryId: string, access: AccessLogEntry) {
        this.update_log_entry(queryId, (entry) => ({
            ...entry,
            access_log: [...entry.access_log, access]
        }));
    }

    public auditQueryLog() {
        // Intentionally left as a placeholder for future periodic audit actions.
    }

    /**
     * Get the executing queries.
     */
    get_executing_queries() {
        return this.executing_queries;
    }

    /**
     * Get the registered queries.
     */
    get_registered_queries() {
        return this.registered_queries;
    }

    /**
     * Send a message to the server.
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
