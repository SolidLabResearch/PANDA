import nock from 'nock';
import { ContinuousAnomalyMonitoringService } from "./ContinuousAnomalyMonitoringService";

beforeEach(() => {
    nock('http://localhost:3000')
        .get('/activity_index_rules')
        .reply(200, `
    @prefix math: <http://www.w3.org/2000/10/swap/math#>.
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
    @prefix ex: <http://example.org/#>.
    {?s <https://saref.etsi.org/core/hasValue> ?o . ?o math:notLessThan 6} => {?s ex:is ex:standing}.
    `);
});

afterEach(() => {
    nock.cleanAll();
})

test('test_reasoning_engine', async () => {
    const data = `<http://example.org/subject> <http://example.org/predicate> <http://example.org/object>. `;
    const n3_reasoner = new ContinuousAnomalyMonitoringService(`@prefix : <http://example.org/rules#>. {?s ?p ?o} => {?s ?o ?p}.`);
    const result = await n3_reasoner.reason(data);
    expect(result).toBe('<http://example.org/subject> <http://example.org/object> <http://example.org/predicate> .\n');
});

test('test_reasoning_engine_with_digits', async () => {
    const data = `<https://rsp.js/aggregation_event/1> <https://saref.etsi.org/core/hasValue> "10"^^<http://www.w3.org/2001/XMLSchema#float> .`
    const rules = `
    @prefix : <http://example.org/rules#>.
    @prefix math: <http://www.w3.org/2000/10/swap/math#>.
    {?s <https://saref.etsi.org/core/hasValue> ?o . ?o math:greaterThan 5 . ?o math:notGreaterThan 15} => {?s <http://example.org/#is> <http://example.org/#standing>}.
    `;
    const n3_reasoner = new ContinuousAnomalyMonitoringService(rules);
    const result = await n3_reasoner.reason(data);
    console.log(result);

    expect(result).toBe('<https://rsp.js/aggregation_event/1> <http://example.org/#is> <http://example.org/#standing> .\n')
});

test('activity_index', async () => {
    const data =
        `
    <https://rsp.js/aggregation_event/first> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://saref.etsi.org/core/Measurement> .
    <https://rsp.js/aggregation_event/first> <https://saref.etsi.org/core/hasTimestamp> "Date"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
    <https://rsp.js/aggregation_event/first> <https://saref.etsi.org/core/hasValue> "8"^^<http://www.w3.org/2001/XMLSchema#float> .
    <https://rsp.js/aggregation_event/first> <http://www.w3.org/ns/prov#wasDerivedFrom> <https://argahsuknesib.github.io/asdo/AggregatorService> .
    <https://rsp.js/aggregation_event/first> <http://w3id.org/rsp/vocals-sd#startedAt> "Date.First"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
    <https://rsp.js/aggregation_event/first> <http://w3id.org/rsp/vocals-sd#endedAt> "Date.Second"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
    `;

    const rules = `   
@prefix : <http://example.org/rules#>.
@prefix math: <http://www.w3.org/2000/10/swap/math#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
@prefix ex: <http://example.org/#>.
@prefix saref: <https://saref.etsi.org/core/> .

# Define activity states based on AI (Activity Index)
{ ?s saref:hasValue ?ai. ?ai math:notGreaterThan 6. } => { ?s ex:is ex:sitting. }.
{ ?s saref:hasValue ?ai. ?ai math:greaterThan 6. ?ai math:notGreaterThan 14. } => { ?s ex:is ex:standing. }.
{ ?s saref:hasValue ?ai. ?ai math:greaterThan 14. ?ai math:notGreaterThan 30. } => { ?s ex:is ex:lightActivity. }.
{ ?s saref:hasValue ?ai. ?ai math:greaterThan 30. ?ai math:notGreaterThan 45. } => { ?s ex:is ex:slowWalking. }.
{ ?s saref:hasValue ?ai. ?ai math:greaterThan 45. ?ai math:notGreaterThan 55. } => { ?s ex:is ex:briskWalking. }.
{ ?s saref:hasValue ?ai. ?ai math:greaterThan 55. } => { ?s ex:is ex:fastWalkingOrJogging. }.

    `;
    const n3_reasoner = new ContinuousAnomalyMonitoringService(rules);
    const result = await n3_reasoner.reason(data);
    expect(result).toBe(result);
})