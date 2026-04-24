import { turtleStringToStore } from "@treecg/ldes-snapshot";
import { DataFactory } from 'rdf-data-factory';
import { LDESinLDP, LDPCommunication } from "@treecg/versionawareldesinldp";
import { RDFStream, RSPEngine } from "rsp-js";
import { TREE } from "@treecg/versionawareldesinldp";
import { create_subscription, extract_ldp_inbox, extract_subscription_server } from "../../utils/notifications/Util";
const DF = new DataFactory();
import { TokenManagerService } from "../authorization/TokenManagerService";
const token_manager = TokenManagerService.getInstance();

/**
 * The NotificationStreamProcessor class is responsible for processing the notifications from the LDES Stream.
 * @class NotificationStreamProcessor
 */
export class NotificationStreamProcessor {
    public ldes_stream: string;
    public rsp_engine: RSPEngine;
    public logger: any;
    public stream_name: RDFStream | undefined;
    public event_emitter: any;
    private readonly auditContext?: QueryExecutionAuditContext;

    /**
     * Creates an instance of NotificationStreamProcessor.
     * @param {string} ldes_stream - The LDES Stream to be processed and received notifications from.
     * @param {*} logger - The logger object.
     * @param {RSPEngine} rsp_engine - The RSP Engine object.
     * @param {*} event_emitter - The event emitter object.
     * @memberof NotificationStreamProcessor
     */
    constructor(ldes_stream: string, logger: any, rsp_engine: RSPEngine, event_emitter: any, auditContext?: QueryExecutionAuditContext) {
        this.ldes_stream = ldes_stream;
        this.logger = logger;
        this.rsp_engine = rsp_engine;
        this.stream_name = rsp_engine.getStream(ldes_stream);
        this.event_emitter = event_emitter;
        this.auditContext = auditContext;
        this.fetchAuthorizedTokenAndInitialize();
        this.logger.info({}, 'notification_stream_processor_started');
    }


    public async fetchAuthorizedTokenAndInitialize() {

        this.subscribe_webhook_events();
        this.retrieve_notification_from_server(this.event_emitter);

    }

    /**
     * Subscribe to the LDES Stream for the latest events.
     * @memberof NotificationStreamProcessor
     */
    public async subscribe_webhook_events() {
        if (this.ldes_stream !== undefined) {
            this.logger.info({}, `subscribing_to_ldes_stream_for_the_latest_events`);
            console.log(`Subscribing to the LDES Stream ${this.ldes_stream} for the latest events`);
            if (this.ldes_stream !== undefined) {
                try {
                    const subscription_server = await extract_subscription_server(this.ldes_stream);
                    if (subscription_server !== undefined) {
                        const server = subscription_server.location;
                        const response_subscription = await create_subscription(server, this.ldes_stream);
                        if (response_subscription) {
                            this.logger.info({}, `subscription_to_ldes_stream_was_successful`);
                            console.log(`Subscription to the LDES Stream ${this.ldes_stream} was successful.`);

                        }
                        else {
                            this.logger.error({}, `subscription_to_ldes_stream_failed`);
                            console.log(`Subscription to the LDES Stream ${this.ldes_stream} failed. The response object is empty.`);
                        }
                    }
                    else {
                        this.logger.error({}, `subscription_server_is_undefined_subscription_to_ldes_stream_failed`);
                        console.log(`The subscription server is undefined. The subscription to the LDES Stream ${this.ldes_stream} failed.`);
                    }
                } catch (error) {
                    this.logger.warn({}, `subscription_to_ldes_stream_failed_with_error`);
                    console.warn(`Subscription setup failed for ${this.ldes_stream}. Continuing with direct webhook handling.`, error);
                    this.auditContext?.onExecutionFailed?.((error as Error).message);
                }
            }
            else {
                this.logger.error({}, `inbox_of_ldes_stream_is_undefined_subscription_to_ldes_stream_failed`);
                console.log(`The inbox of the LDES Stream ${this.ldes_stream} is undefined. The subscription to the LDES Stream failed.`);
            }
        }
        else {
            this.logger.error({}, `ldes_stream_is_undefined_subscription_to_ldes_stream_failed`);
            console.log(`The LDES Stream is undefined. The subscription to the LDES Stream failed.`);
        }
    }


    /**
     * Retrieve the notification from the server.
     * @param {*} event_emitter - The event emitter object.
     * @memberof NotificationStreamProcessor
     */
    public async retrieve_notification_from_server(event_emitter: any) {
        /**
         * At the current moment, the LDES in LDP library doesn't initialize with the 
         * support for authorization tokens, which caused the .readMeatadata() and the initialization
         * of the LDES in LDP to fail as it could not find the relevant stream.
         * Therefore, currently we hardcode the bucket strategy / timestamp predicate we require for the 
         * usage to fetch the timestamp. (SAREF:hasTimestamp in our case)
         * 
         * const ldes = new LDESinLDP(this.ldes_stream, new LDPCommunication());
         * const metadata = await ldes.readMetadata();
         * const bucket_strategy = metadata.getQuads(this.ldes_stream + "#BucketizeStrategy", TREE.path, null, null)[0].object.value;
         */
        const timestamp_predicate = "https://saref.etsi.org/core/hasTimestamp";
        const has_value_predicate = "https://saref.etsi.org/core/hasValue";
        const relates_to_property_predicate = "https://saref.etsi.org/core/relatesToProperty";
        const expected_property_iri = process.env.PANDA_EXPECTED_PROPERTY_IRI;
        event_emitter.on(`${this.ldes_stream}`, async (latest_event: string) => {
            this.auditContext?.onDataAccess?.(this.ldes_stream);
            this.logger.info({}, 'latest_event_received_preprocessing_started');
            const processing_started_epoch = Date.now();
            console.log(`[VALIDATION][INGEST] event_received stream=${this.ldes_stream} processing_time_iso=${new Date(processing_started_epoch).toISOString()} processing_time_epoch=${processing_started_epoch}`);
            /** 
             * The latest event is a string in Turtle format.
             * Under the assumption that the event is a set of triple(s), where you have one stream event per LDP resource.
             * The LDP resource was created using a POST request, and the event is the response of the POST request.
             * The difference between POST and PATCH in our context of the aggregation is that with POST, the notification received and being processed is
             * a "Add", whereas with a PATCH it is an "Update" to the same document. To extract the event from the LDP resource generated from PATCH,
             * we need to compare the LDP resource before and after the PATCH request (i.e doing an incremental maintainance of the LDP resource) which is out of scope
             * of the Solid Stream Aggregator (for now, and the support for this will be implemented in the future).
             */
            let latest_event_store: any;
            try {
                latest_event_store = await turtleStringToStore(latest_event);
            } catch (error) {
                this.logger.warn({}, 'latest_event_parsing_failed_skipping_event');
                console.warn(`Skipping malformed latest event for ${this.ldes_stream}.`, error);
                return;
            }
            const parsed_quads = latest_event_store.getQuads(null, null, null, null);
            console.log(`[VALIDATION][INGEST] parsed_quads_count stream=${this.ldes_stream} quad_count=${parsed_quads.length}`);
            parsed_quads.forEach((quad: any, index: number) => {
                console.log(`[VALIDATION][INGEST] parsed_quad index=${index} subject=${quad.subject.value} predicate=${quad.predicate.value} object=${quad.object.value} object_termType=${quad.object.termType} object_datatype=${quad.object.datatype?.value ?? ''}`);
            });

            const timestamp_quad = latest_event_store.getQuads(null, DF.namedNode(timestamp_predicate), null, null)[0];
            if (!timestamp_quad) {
                this.logger.warn({}, 'latest_event_missing_timestamp_skipping_event');
                console.log(`[VALIDATION][INGEST] skip_stream_add reason=missing_timestamp_predicate timestamp_predicate=${timestamp_predicate}`);
                console.warn(`Skipping latest event without ${timestamp_predicate} for ${this.ldes_stream}.`);
                return;
            }
            const eventId = timestamp_quad.subject.value;
            console.log(`[MEASURE][INGEST] event_received timestamp=${new Date().toISOString()} event_id=${eventId}`);
            const timestamp = timestamp_quad.object.value;
            const timestamp_epoch = Date.parse(timestamp);
            console.log(`[VALIDATION][INGEST] timestamp_raw event_id=${eventId} literal=${timestamp} datatype=${timestamp_quad.object.datatype?.value ?? ''}`);
            console.log(`[VALIDATION][INGEST] timestamp_parsed event_id=${eventId} epoch=${timestamp_epoch} is_nan=${Number.isNaN(timestamp_epoch)} is_finite=${Number.isFinite(timestamp_epoch)}`);

            const hasValueQuad = latest_event_store.getQuads(timestamp_quad.subject, DF.namedNode(has_value_predicate), null, null)[0];
            const relatesToPropertyQuad = latest_event_store.getQuads(timestamp_quad.subject, DF.namedNode(relates_to_property_predicate), null, null)[0];
            const propertyIri = relatesToPropertyQuad?.object?.value;
            const propertyMatchesExpected = expected_property_iri ? propertyIri === expected_property_iri : 'not_checked';
            console.log(`[VALIDATION][INGEST] extraction event_id=${eventId} hasValue_found=${Boolean(hasValueQuad)} relatesToProperty_found=${Boolean(relatesToPropertyQuad)} property_iri=${propertyIri ?? ''} expected_property_iri=${expected_property_iri ?? ''} property_matches_expected=${propertyMatchesExpected}`);

            if (Number.isNaN(timestamp_epoch)) {
                this.logger.warn({}, 'latest_event_invalid_timestamp_skipping_event');
                console.log(`[VALIDATION][INGEST] skip_stream_add reason=invalid_timestamp event_id=${eventId} raw_timestamp=${timestamp}`);
                console.warn(`Skipping latest event with invalid timestamp ${timestamp} for ${this.ldes_stream}.`);
                return;
            }
            console.log(`[VALIDATION][INGEST] timestamp_extracted stream=${this.ldes_stream} event_timestamp_literal=${timestamp} event_timestamp_epoch=${timestamp_epoch}`);
            if (this.stream_name) {
                console.log(`[VALIDATION][INGEST] stream_add_decision event_id=${eventId} will_call_stream_add=true stream_name=${this.stream_name.name} quad_count=${parsed_quads.length}`);
                this.logger.info({}, 'latest_event_received_preprocessing_completed_adding_to_rsp_engine_started');
                console.log(`Adding the event store to the RSP Engine for the stream ${this.stream_name}`);
                await this.add_event_store_to_rsp_engine(latest_event_store, [this.stream_name], timestamp_epoch);
                this.logger.info({}, 'latest_event_added_to_rsp_engine');
                console.log(`[VALIDATION][INGEST] event_added_to_rsp_engine stream=${this.ldes_stream} event_timestamp_epoch=${timestamp_epoch}`);
                console.log(`[MEASURE][RSP] event_added timestamp=${new Date().toISOString()} event_id=${eventId}`);
            } else {
                console.log(`[VALIDATION][INGEST] skip_stream_add reason=stream_name_undefined event_id=${eventId}`);
            }
        });
    }

    /**
     * Add the event store to the RSP Engine.
     * @param {*} event_store - The event store generated from the latest event to be added to the RSP Engine.
     * @param {RDFStream[]} stream_name - The name of the stream to which the event store is to be added.
     * @param {number} timestamp - The timestamp of the event.
     * @memberof NotificationStreamProcessor
     */
    public async add_event_store_to_rsp_engine(event_store: any, stream_name: RDFStream[], timestamp: number) {
        stream_name.forEach(async (stream: RDFStream) => {
            const quads = event_store.getQuads(null, null, null, null);
            console.log(`[VALIDATION][INGEST] add_event_store_quads stream=${stream.name} quad_count=${quads.length} timestamp_epoch=${timestamp} timestamp_iso=${new Date(timestamp).toISOString()}`);
            for (const quad of quads) {
                console.log(`[VALIDATION][INGEST] quad subject=${quad.subject.value} predicate=${quad.predicate.value} object=${quad.object.value}`);
                stream.add(quad, timestamp)
            }
        });
    }
}

type QueryExecutionAuditContext = {
    queryId: string;
    actorWebId: string;
    onDataAccess?: (resource: string) => void;
    onExecutionFailed?: (errorMessage: string) => void;
}
