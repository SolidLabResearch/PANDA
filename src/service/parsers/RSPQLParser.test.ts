import { RSPQLParser } from "./RSPQLParser";

describe('RSPQLParser', () => {

    let parser: RSPQLParser;

    beforeEach(() => {
        parser = new RSPQLParser();
    });

    const rspql_query = `
    PREFIX saref: <https://saref.etsi.org/core/>
    PREFIX dahccsensors: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/>
    PREFIX : <https://rsp.js/>
    REGISTER RStream <output> AS
    SELECT (MAX(?o) as ?maxSKT)
    FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/> [RANGE 180000 STEP 30000]
    WHERE {
        WINDOW :w1 {
            ?s saref:hasValue ?o .
            ?s saref:relatesToProperty dahccsensors:wearable.skt .
        }   
    }
    `;
    it('should_parse_the_rspql_query', () => {
        const parsed_query = parser.parse(rspql_query);
        expect(parsed_query).toBeDefined();
        expect(parsed_query.sparql).toContain('SELECT (MAX(?o) as ?maxSKT)');
        expect(parsed_query.sparql).toContain('WHERE');
        expect(parsed_query.sparql).toContain('GRAPH :w1');
        expect(parsed_query.r2s).toEqual({ operator: 'RStream', name: 'output' });
        expect(parsed_query.s2r).toEqual([{ window_name: 'https://rsp.js/w1', stream_name: 'http://localhost:3000/', width: 180000, slide: 30000 }]);        
        expect(parsed_query.aggregation_thing_in_context.length).toBe(0);
        expect(parsed_query.prefixes.size).toBe(3);
    });

    it('should_parse_compact_query_with_where_adjacent_to_projection', () => {
        const compact = `PREFIX saref: <https://saref.etsi.org/core/> PREFIX : <https://rsp.js/> REGISTER RStream <output> AS SELECT (AVG(?o) AS ?avgValue)FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/spo2/> [RANGE 20000 STEP 5000] WHERE { WINDOW :w1 { ?s saref:hasValue ?o . } }`;
        const parsed_query = parser.parse(compact);
        expect(parsed_query.sparql).toContain('SELECT (AVG(?o) AS ?avgValue) WHERE');
        expect(parsed_query.s2r).toEqual([{
            window_name: 'https://rsp.js/w1',
            stream_name: 'http://localhost:3000/alice/spo2/',
            width: 20000,
            slide: 5000
        }]);
    });

    it('should_unwrap_the_prefixed_iri', () => {
        const prefixMapper = new Map<string, string>();
        prefixMapper.set('saref', 'https://saref.etsi.org/core/');
        prefixMapper.set('dahccsensors', 'https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/');
        const unwrapped = parser.unwrap('saref:hasValue', prefixMapper);
        expect(unwrapped).toBe('https://saref.etsi.org/core/hasValue');
    });

    it('should_unwrap_the_full_iri', () => {
        const prefixMapper = new Map<string, string>();
        const unwrapped = parser.unwrap('<https://saref.etsi.org/core/hasValue>', prefixMapper);
        expect(unwrapped).toBe('https://saref.etsi.org/core/hasValue');
    });

    it('should_unwrap_the_prefixed_iri_with_no_prefix', () => {
        const prefixMapper = new Map<string, string>();
        const unwrapped = parser.unwrap('hasValue', prefixMapper);
        expect(unwrapped).toBe('');
    });

    it('should_unwrap_the_prefixed_iri_with_no_prefix_mapper', () => {
        const unwrapped = parser.unwrap('saref:hasValue', new Map<string, string>());
        expect(unwrapped).toBe('');
    });
});
