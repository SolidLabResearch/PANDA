import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuditLoggedQueryService } from './AuditLoggedQueryService';

jest.mock('../aggregator/AggregatorInstantiator', () => ({
    AggregatorInstantiator: jest.fn().mockImplementation(() => ({}))
}));

describe('AuditLoggedQueryService', () => {
    let queryRegistry: AuditLoggedQueryService;
    let logPath: string;

    const logger = {
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn()
    };

    const baseQuery = `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>
REGISTER RStream <output> AS
SELECT (AVG(?o) as ?avgSKT)
FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/acc-x/> [RANGE 800 STEP 100]
WHERE {
  WINDOW :w1 {
    ?s saref:hasValue ?o .
  }
}
`;

    beforeEach(() => {
        queryRegistry = new AuditLoggedQueryService();
        logPath = path.join(os.tmpdir(), `query_audit_test_${Date.now()}_${Math.random()}.json`);
        (queryRegistry as any).logFilePath = logPath;
        fs.writeFileSync(logPath, '[]');
        jest.clearAllMocks();
    });

    afterEach(() => {
        if (fs.existsSync(logPath)) {
            fs.unlinkSync(logPath);
        }
    });

    it('registers a new query with audit metadata and executing status', async () => {
        const result = await queryRegistry.register_query({
            rspql_query: baseQuery,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/nurse#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        expect(result.should_execute).toBe(true);
        const entry = queryRegistry.get_query_log_by_id(result.query_id);
        expect(entry).toBeDefined();
        expect(entry?.registered_by).toBe('https://webid.org/nurse#me');
        expect(entry?.status).toBe('executing');
        expect(entry?.similar_queries_id).toEqual([]);
    });

    it('records status transitions', async () => {
        const result = await queryRegistry.register_query({
            rspql_query: baseQuery,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/nurse#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        const updated = queryRegistry.mark_query_status(result.query_id, 'executed');
        expect(updated).toBe(true);
        expect(queryRegistry.get_query_log_by_id(result.query_id)?.status).toBe('executed');
    });

    it('finds similar queries using normalized query text and keeps references', async () => {
        const first = await queryRegistry.register_query({
            rspql_query: baseQuery,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/nurse#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        const normalizedVariant = `PREFIX saref: <https://saref.etsi.org/core/>\nPREFIX : <https://rsp.js/>\nREGISTER RStream <output> AS SELECT (AVG(?o) as ?avgSKT) FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/acc-x/> [RANGE 800 STEP 100] WHERE { WINDOW :w1 { ?s saref:hasValue ?o . } }`;

        const second = await queryRegistry.register_query({
            rspql_query: normalizedVariant,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/doctor#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        const secondEntry = queryRegistry.get_query_log_by_id(second.query_id);
        expect(secondEntry?.similar_queries_id).toContain(first.query_id);
        expect(secondEntry?.reuse_decision).toBe('not_reused_actor_scope_mismatch');
        expect(second.should_execute).toBe(true);
    });

    it('prevents duplicate execution when same actor and scope submit same normalized query', async () => {
        const first = await queryRegistry.register_query({
            rspql_query: baseQuery,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/nurse#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        queryRegistry.mark_query_status(first.query_id, 'executed');

        const duplicate = await queryRegistry.register_query({
            rspql_query: baseQuery,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/nurse#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        expect(duplicate.should_execute).toBe(false);
        const duplicateEntry = queryRegistry.get_query_log_by_id(duplicate.query_id);
        expect(duplicateEntry?.reuse_decision).toBe('reused_existing');
        expect(duplicateEntry?.reused_from_query_id).toBe(first.query_id);
    });

    it('logs data access events on query entries', async () => {
        const registered = await queryRegistry.register_query({
            rspql_query: baseQuery,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/nurse#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        queryRegistry.logAccess(registered.query_id, {
            user: 'https://webid.org/nurse#me',
            timestamp: new Date().toISOString(),
            data_accessed: 'http://localhost:3000/alice/acc-x/'
        });

        const entry = queryRegistry.get_query_log_by_id(registered.query_id);
        expect(entry?.access_log.length).toBe(1);
        expect(entry?.access_log[0].data_accessed).toBe('http://localhost:3000/alice/acc-x/');
    });

    it('does not reuse across actors even with same normalized query and same scope', async () => {
        await queryRegistry.register_query({
            rspql_query: baseQuery,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/nurse#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        const secondActor = await queryRegistry.register_query({
            rspql_query: baseQuery,
            rules: '',
            from_timestamp: Date.now() - 1000,
            to_timestamp: Date.now(),
            logger,
            query_type: 'historical+live',
            event_emitter: {},
            actor_webid: 'https://webid.org/researcher#me',
            authorization_scope: ['http://localhost:3000/alice/acc-x/']
        });

        expect(secondActor.should_execute).toBe(true);
        const entry = queryRegistry.get_query_log_by_id(secondActor.query_id);
        expect(entry?.reuse_decision).toBe('not_reused_actor_scope_mismatch');
    });
});
