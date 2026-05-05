import { reason as n3reasoner } from "eyeling";
const N3 = require('n3');

const XSD_FLOAT = 'http://www.w3.org/2001/XMLSchema#float';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_DOUBLE = 'http://www.w3.org/2001/XMLSchema#double';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#int';
const XSD_LONG = 'http://www.w3.org/2001/XMLSchema#long';
const XSD_SHORT = 'http://www.w3.org/2001/XMLSchema#short';
const XSD_BYTE = 'http://www.w3.org/2001/XMLSchema#byte';
const XSD_NON_NEGATIVE_INTEGER = 'http://www.w3.org/2001/XMLSchema#nonNegativeInteger';
const XSD_POSITIVE_INTEGER = 'http://www.w3.org/2001/XMLSchema#positiveInteger';
const XSD_NON_POSITIVE_INTEGER = 'http://www.w3.org/2001/XMLSchema#nonPositiveInteger';
const XSD_NEGATIVE_INTEGER = 'http://www.w3.org/2001/XMLSchema#negativeInteger';

const NUMERIC_DATATYPES = new Set([
    XSD_FLOAT,
    XSD_DECIMAL,
    XSD_DOUBLE,
    XSD_INTEGER,
    XSD_INT,
    XSD_LONG,
    XSD_SHORT,
    XSD_BYTE,
    XSD_NON_NEGATIVE_INTEGER,
    XSD_POSITIVE_INTEGER,
    XSD_NON_POSITIVE_INTEGER,
    XSD_NEGATIVE_INTEGER,
]);

export class ContinuousAnomalyMonitoringService {
    private static instance: ContinuousAnomalyMonitoringService;
    private n3_rules: string;

    private constructor(rules: string) {
        this.n3_rules = rules;
    }

    public static getInstance(rules: string): ContinuousAnomalyMonitoringService {
        if (!ContinuousAnomalyMonitoringService.instance) {
            ContinuousAnomalyMonitoringService.instance = new ContinuousAnomalyMonitoringService(rules);
        } else {
            // Keep singleton lifecycle but refresh rule content for each query registration/update.
            ContinuousAnomalyMonitoringService.instance.rules = rules;
        }
        return ContinuousAnomalyMonitoringService.instance;
    }

    public get rules(): string {
        return this.n3_rules;
    }

    public set rules(rules: string) {
        this.n3_rules = rules;
    }

    public async reason(data: string): Promise<string> {
        const n3_parser = new N3.Parser({ format: 'text/n3' });
        const rule_eval_time = Date.now();
        console.log(`[VALIDATION][RULE] rule_evaluation_started processing_time_epoch=${rule_eval_time} processing_time_iso=${new Date(rule_eval_time).toISOString()}`);

        console.log(`Data to be reasoned over is ${data}`);
        console.log(`Rules to be reasoned are ${this.n3_rules}`);
        
        const data_parsed = n3_parser.parse(data);
        const has_value_predicate = 'https://saref.etsi.org/core/hasValue';
        const valueQuads = data_parsed.filter((quad: any) => quad.predicate.value === has_value_predicate);
        if (valueQuads.length === 0) {
            console.log('[VALIDATION][RULE] rule_not_matched reason=no_hasValue_found');
        }

        for (const quad of valueQuads) {
            const parsedValue = this.parseNumericLiteral(quad.object);
            console.log(`[VALIDATION][RULE] spo2_binding subject=${quad.subject.value} lexical="${quad.object.value}" datatype=${quad.object.datatype?.value ?? 'none'} parsed_numeric=${parsedValue === null ? 'NaN' : parsedValue}`);
        }

        const comparisons = this.extractMathComparisons(this.n3_rules);
        if (comparisons.length === 0) {
            console.log('[VALIDATION][RULE] numeric_comparison_executed=false reason=no_supported_math_builtin_found');
        } else {
            for (const comparison of comparisons) {
                console.log(`[VALIDATION][RULE] numeric_comparison_detected builtin=${comparison.builtin} variable=${comparison.variable} threshold=${comparison.threshold}`);
                for (const quad of valueQuads) {
                    const parsedValue = this.parseNumericLiteral(quad.object);
                    if (parsedValue === null) {
                        console.log(`[VALIDATION][RULE] numeric_comparison_executed=true builtin=${comparison.builtin} subject=${quad.subject.value} result=skipped_non_numeric`);
                        continue;
                    }
                    const matched = this.evaluateComparison(comparison.builtin, parsedValue, comparison.threshold);
                    console.log(`[VALIDATION][RULE] numeric_comparison_executed=true builtin=${comparison.builtin} subject=${quad.subject.value} bound_value=${parsedValue} threshold=${comparison.threshold} result=${matched}`);
                }
            }
        }

        const reasoner_input = `${this.n3_rules}\n${data}`;
        const inferred_output = await n3reasoner({ proofComments: false }, reasoner_input);
        const inferred_alert = ContinuousAnomalyMonitoringService.outputContainsAlertTriple(inferred_output);
        console.log(`[VALIDATION][RULE] reasoner_output_contains_alert=${inferred_alert}`);

        console.log(`Inferred event is ${inferred_output}`);

        return inferred_output;
    }

    public static outputContainsAlertTriple(reasonedResult: string): boolean {
        if (reasonedResult.trim().length === 0) {
            return false;
        }
        const parser = new N3.Parser({ format: 'text/n3' });
        const quads = parser.parse(reasonedResult);
        return quads.some((quad: any) => quad.predicate.value === 'http://example.org/alert');
    }

    private parseNumericLiteral(term: any): number | null {
        if (!term) {
            return null;
        }
        if (term.termType === 'Literal') {
            const datatype = term.datatype?.value;
            if (datatype && !NUMERIC_DATATYPES.has(datatype)) {
                return null;
            }
        }
        const parsed = Number(term.value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private extractMathComparisons(rules: string): Array<{ builtin: string; variable: string; threshold: number }> {
        const comparisons: Array<{ builtin: string; variable: string; threshold: number }> = [];
        const supportedBuiltins = ['lessThan', 'greaterThan', 'notLessThan', 'notGreaterThan', 'equalTo', 'notEqualTo'];
        for (const builtin of supportedBuiltins) {
            const expression = new RegExp(`(\\?[A-Za-z_][A-Za-z0-9_]*)\\s+math:${builtin}\\s+(-?\\d+(?:\\.\\d+)?)`, 'g');
            for (const match of rules.matchAll(expression)) {
                comparisons.push({
                    builtin,
                    variable: match[1],
                    threshold: Number(match[2]),
                });
            }
        }
        return comparisons;
    }

    private evaluateComparison(builtin: string, value: number, threshold: number): boolean {
        switch (builtin) {
            case 'lessThan':
                return value < threshold;
            case 'greaterThan':
                return value > threshold;
            case 'notLessThan':
                return value >= threshold;
            case 'notGreaterThan':
                return value <= threshold;
            case 'equalTo':
                return value === threshold;
            case 'notEqualTo':
                return value !== threshold;
            default:
                return false;
        }
    }
}
