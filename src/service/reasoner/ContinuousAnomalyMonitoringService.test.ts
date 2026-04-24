import { ContinuousAnomalyMonitoringService } from "./ContinuousAnomalyMonitoringService";

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