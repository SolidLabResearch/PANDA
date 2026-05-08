import { Bindings } from "@comunica/types";
import { LDESinLDP, LDPCommunication, SolidCommunication } from "@treecg/versionawareldesinldp";
import { RateLimitedLDPCommunication } from "rate-limited-ldp-communication";
import { Quad } from "rdflib/lib/tf-types";
import { BenchmarkTimingSnapshot } from "./benchmark/BenchmarkTiming";

export type QuadWithID = {
    id: string;
    quads: Quad[];
}

export type RequestBody = {
    query: string;
    latest_minutes: number;
    query_type: string;
}

export type AggregatorServerOptions = {
    port: number;
    solid_server_url: string;
}

export type BindingsWithTimestamp = {
    bindings: Bindings,
    timestamp_from: number,
    timestamp_to: number
}

export type WebSocketMessage = {
    type: string,
    data: unknown
}

export type Prefixes = { [key: string]: string }

export type readOpts =  {
    from?: Date,
    to?: Date,
    ldes: LDESinLDP,
    communication: LDPCommunication | SolidCommunication | RateLimitedLDPCommunication,
    rate: number,
    interval: number
}

export type aggregationDispatcherType = {
    from ?: Date,
    to ?: Date
}

export type SubscriptionServerNotification = {
    location: string,
    channelType: string,
    channelLocation: string
}

export type aggregation_object = {
    query_hash: string,
    aggregation_event: string,
    aggregation_window_from: Date,
    aggregation_window_to: Date,
    rsp_window_metadata?: {
        raw_timestamp_from: number | null,
        raw_timestamp_to: number | null,
        event_time_span_ms: number | null,
        source: string,
    },
    benchmark_timing?: BenchmarkTimingSnapshot
}

export type Credentials = {
    [key: string]: {
        id: string;
        secret: string;
        idp: string;
    };
};
