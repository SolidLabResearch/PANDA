import { ContinuousAnomalyMonitoringService } from "./ContinuousAnomalyMonitoringService";
import { AggregatorInstantiator } from "../aggregator/AggregatorInstantiator";
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

test('does not infer low SpO2 alert for xsd:float value 94', async () => {
    const rules = `
@prefix saref: <https://saref.etsi.org/core/> .
@prefix math: <http://www.w3.org/2000/10/swap/math#> .
@prefix ex: <http://example.org/> .

{ ?s saref:hasValue ?spo2Value . ?spo2Value math:lessThan 90. }
=> { ?s ex:alert "SPO2_LOW". }.
`;
    const data = '<https://rsp.js/aggregation_event/94> <https://saref.etsi.org/core/hasValue> "94"^^<http://www.w3.org/2001/XMLSchema#float> .';

    const reasoner = ContinuousAnomalyMonitoringService.getInstance(rules);
    const result = await reasoner.reason(data);

    expect(result.trim()).toBe('');
    expect(ContinuousAnomalyMonitoringService.outputContainsAlertTriple(result)).toBe(false);
});

test('infers low SpO2 alert for xsd:float value 89', async () => {
    const rules = `
@prefix saref: <https://saref.etsi.org/core/> .
@prefix math: <http://www.w3.org/2000/10/swap/math#> .
@prefix ex: <http://example.org/> .

{ ?s saref:hasValue ?spo2Value . ?spo2Value math:lessThan 90. }
=> { ?s ex:alert "SPO2_LOW". }.
`;
    const data = '<https://rsp.js/aggregation_event/89> <https://saref.etsi.org/core/hasValue> "89"^^<http://www.w3.org/2001/XMLSchema#float> .';

    const reasoner = ContinuousAnomalyMonitoringService.getInstance(rules);
    const result = await reasoner.reason(data);
    const quads = new N3.Parser({ format: 'text/n3' }).parse(result);

    expect(quads).toEqual(expect.arrayContaining([
        expect.objectContaining({
            subject: expect.objectContaining({ value: 'https://rsp.js/aggregation_event/89' }),
            predicate: expect.objectContaining({ value: 'http://example.org/alert' }),
            object: expect.objectContaining({ value: 'SPO2_LOW' }),
        }),
    ]));
    expect(ContinuousAnomalyMonitoringService.outputContainsAlertTriple(result)).toBe(true);
});

test('alert detection ignores unrelated alert substrings', () => {
    const unrelated = '<http://localhost:3000/alice/derived/anomaly-alert/test> <http://example.org/value> "94" .';
    expect(ContinuousAnomalyMonitoringService.outputContainsAlertTriple(unrelated)).toBe(false);
});

test('extracts benchmark run marker from benchmark source event uri', () => {
    const marker = (AggregatorInstantiator.prototype as any).extractBenchmarkRunMarker.call(
        {},
        'http://example.org/panda-benchmark/uma-replayer-panda-derived-anomaly-e2e-1-abc123/spo2/11',
    );
    expect(marker).toBe('uma-replayer-panda-derived-anomaly-e2e-1-abc123');
});
