export interface StreamConfig {
    location: string;
    file_location: string;
}

export interface ReplayConfig {
    streams: StreamConfig[];
    frequency_event: number;
    frequency_buffer: number;
    is_ldes: boolean;
    tree_path: string;
}
