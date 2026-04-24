import { reason as n3reasoner } from "eyeling";
const N3 = require('n3');

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
        const numeric_values = data_parsed
            .filter((quad: any) => quad.predicate.value === has_value_predicate)
            .map((quad: any) => Number(quad.object.value))
            .filter((value: number) => !Number.isNaN(value));
        const threshold = 90;
        if (numeric_values.length === 0) {
            console.log(`[VALIDATION][RULE] rule_not_matched reason=no_hasValue_found threshold=${threshold}`);
        } else {
            for (const value of numeric_values) {
                const matched = value < threshold;
                if (matched) {
                    console.log(`[VALIDATION][RULE] rule_matched condition=spo2Value<${threshold} spo2Value=${value}`);
                } else {
                    console.log(`[VALIDATION][RULE] rule_not_matched condition=spo2Value<${threshold} spo2Value=${value}`);
                }
            }
        }

        const reasoner_input = `${this.n3_rules}\n${data}`;
        const inferred_output = await n3reasoner({ proofComments: false }, reasoner_input);
        const inferred_alert = inferred_output.includes('alert');
        console.log(`[VALIDATION][RULE] reasoner_output_contains_alert=${inferred_alert}`);

        console.log(`Inferred event is ${inferred_output}`);

        return inferred_output;
    }
}
