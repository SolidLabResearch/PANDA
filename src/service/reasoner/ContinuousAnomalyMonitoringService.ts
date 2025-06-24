import { storeToString } from "@treecg/ldes-snapshot";
import { n3reasoner } from "eyereasoner";
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

        console.log(`Data to be reasoned over is ${data}`);
        console.log(`Rules to be reasoned are ${this.n3_rules}`);
        
        const store = new N3.Store();
        const rules = n3_parser.parse(this.n3_rules);
        const data_parsed = n3_parser.parse(data);

        for (const elem of rules) {
            store.addQuad(elem);
        }

        for (const elem of data_parsed) {
            store.addQuad(elem);
        }

        const inferredStore = new N3.Store(await n3reasoner(store.getQuads(), undefined, {
            output: 'derivations',
            outputType: 'quads',
        }));

        console.log(`Inferred event is ${storeToString(inferredStore)}`);

        return storeToString(inferredStore);
    }
}
