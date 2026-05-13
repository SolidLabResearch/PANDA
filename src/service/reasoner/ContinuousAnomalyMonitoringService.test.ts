import { ContinuousAnomalyMonitoringService } from "./ContinuousAnomalyMonitoringService";
const N3 = require('n3');

test('infers expected standing triple for numeric value', async () => {
    const data = '<https://rsp.js/aggregation_event/1> <https://saref.etsi.org/core/hasValue> "10"^^<http://www.w3.org/2001/XMLSchema#float> .';
    const rules = `
@prefix math: <http://www.w3.org/2000/10/swap/math#>.
{ ?s <https://saref.etsi.org/core/hasValue> ?o . ?o math:greaterThan 5 . ?o math:notGreaterThan 15 }
=> { ?s <http://example.org/#is> <http://example.org/#standing> }.
`;

    const reasoner = ContinuousAnomalyMonitoringService.getInstance(rules);
    const result = await reasoner.reason(data);

    expect(result).toContain('<https://rsp.js/aggregation_event/1> <http://example.org/#is> <http://example.org/#standing> .');
});

test('singleton instance refreshes rules between registrations', async () => {
    const firstRules = `
@prefix math: <http://www.w3.org/2000/10/swap/math#>.
{ ?s <https://saref.etsi.org/core/hasValue> ?o . ?o math:lessThan 90 }
=> { ?s <http://example.org/#status> <http://example.org/#lowSpo2> }.
`;
    const secondRules = `
@prefix math: <http://www.w3.org/2000/10/swap/math#>.
{ ?s <https://saref.etsi.org/core/hasValue> ?o . ?o math:notLessThan 90 }
=> { ?s <http://example.org/#status> <http://example.org/#normalSpo2> }.
`;
    const data = '<https://rsp.js/aggregation_event/2> <https://saref.etsi.org/core/hasValue> "95"^^<http://www.w3.org/2001/XMLSchema#float> .';

    const firstInstance = ContinuousAnomalyMonitoringService.getInstance(firstRules);
    const secondInstance = ContinuousAnomalyMonitoringService.getInstance(secondRules);

    expect(firstInstance).toBe(secondInstance);

    const result = await secondInstance.reason(data);
    expect(result).toContain('<https://rsp.js/aggregation_event/2> <http://example.org/#status> <http://example.org/#normalSpo2> .');
    expect(result).not.toContain('<https://rsp.js/aggregation_event/2> <http://example.org/#status> <http://example.org/#lowSpo2> .');
});

test('does not infer elevated heart-rate alert for xsd:float value 94', async () => {
    const rules = `
@prefix saref: <https://saref.etsi.org/core/> .
@prefix math: <http://www.w3.org/2000/10/swap/math#> .
@prefix ex: <http://example.org/> .

{ ?s saref:hasValue ?value . ?value math:greaterThan 99.9. }
=> { ?s ex:alert "ELEVATED_HEART_RATE". }.
`;
    const data = '<https://rsp.js/aggregation_event/94> <https://saref.etsi.org/core/hasValue> "94"^^<http://www.w3.org/2001/XMLSchema#float> .';

    const reasoner = ContinuousAnomalyMonitoringService.getInstance(rules);
    const result = await reasoner.reason(data);

    expect(result.trim()).toBe('');
    expect(ContinuousAnomalyMonitoringService.outputContainsAlertTriple(result)).toBe(false);
});

test('infers elevated heart-rate alert for xsd:float value 101', async () => {
    const rules = `
@prefix saref: <https://saref.etsi.org/core/> .
@prefix math: <http://www.w3.org/2000/10/swap/math#> .
@prefix ex: <http://example.org/> .

{ ?s saref:hasValue ?value . ?value math:greaterThan 99.9. }
=> { ?s ex:alert "ELEVATED_HEART_RATE". }.
`;
    const data = '<https://rsp.js/aggregation_event/101> <https://saref.etsi.org/core/hasValue> "101"^^<http://www.w3.org/2001/XMLSchema#float> .';

    const reasoner = ContinuousAnomalyMonitoringService.getInstance(rules);
    const result = await reasoner.reason(data);
    const quads = new N3.Parser({ format: 'text/n3' }).parse(result);

    expect(quads).toEqual(expect.arrayContaining([
        expect.objectContaining({
            subject: expect.objectContaining({ value: 'https://rsp.js/aggregation_event/101' }),
            predicate: expect.objectContaining({ value: 'http://example.org/alert' }),
            object: expect.objectContaining({ value: 'ELEVATED_HEART_RATE' }),
        }),
    ]));
    expect(ContinuousAnomalyMonitoringService.outputContainsAlertTriple(result)).toBe(true);
});

test('alert detection ignores unrelated alert substrings', () => {
    const unrelated = '<http://localhost:3000/alice/derived/anomaly-alert/test> <http://example.org/value> "94" .';
    expect(ContinuousAnomalyMonitoringService.outputContainsAlertTriple(unrelated)).toBe(false);
});
