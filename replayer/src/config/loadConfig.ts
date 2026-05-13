import * as fs from 'fs';
import { ReplayConfig, StreamConfig } from './types';

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function assertValidStream(stream: unknown, index: number): asserts stream is StreamConfig {
    if (!stream || typeof stream !== 'object') {
        throw new Error(`Invalid stream config at index ${index}: expected an object.`);
    }

    const location = (stream as Partial<StreamConfig>).location;
    const fileLocation = (stream as Partial<StreamConfig>).file_location;

    if (!isNonEmptyString(location)) {
        throw new Error(`Invalid stream config at index ${index}: "location" is required and must be a non-empty string.`);
    }
    if (!isNonEmptyString(fileLocation)) {
        throw new Error(`Invalid stream config at index ${index}: "file_location" is required and must be a non-empty string.`);
    }
    if (!fs.existsSync(fileLocation)) {
        throw new Error(`Invalid stream config at index ${index}: file does not exist at "${fileLocation}".`);
    }
}

export function parseReplayConfig(raw: unknown): ReplayConfig {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Invalid config: expected a JSON object.');
    }

    const candidate = raw as Partial<ReplayConfig> & { locations?: unknown; file_location?: unknown };

    if (!Array.isArray(candidate.streams)) {
        if (candidate.locations !== undefined || candidate.file_location !== undefined) {
            throw new Error('Invalid config: legacy "locations + file_location" format is no longer supported. Migrate to "streams".');
        }
        throw new Error('Invalid config: "streams" is required and must be an array.');
    }

    if (candidate.streams.length === 0) {
        throw new Error('Invalid config: "streams" must contain at least one stream.');
    }

    candidate.streams.forEach((stream, index) => assertValidStream(stream, index));

    if (typeof candidate.frequency_event !== 'number' || Number.isNaN(candidate.frequency_event) || candidate.frequency_event <= 0) {
        throw new Error('Invalid config: "frequency_event" must be a positive number.');
    }
    if (typeof candidate.frequency_buffer !== 'number' || Number.isNaN(candidate.frequency_buffer) || candidate.frequency_buffer <= 0) {
        throw new Error('Invalid config: "frequency_buffer" must be a positive number.');
    }
    if (typeof candidate.is_ldes !== 'boolean') {
        throw new Error('Invalid config: "is_ldes" must be a boolean.');
    }
    if (!isNonEmptyString(candidate.tree_path)) {
        throw new Error('Invalid config: "tree_path" is required and must be a non-empty string.');
    }

    return {
        streams: candidate.streams,
        frequency_event: candidate.frequency_event,
        frequency_buffer: candidate.frequency_buffer,
        is_ldes: candidate.is_ldes,
        tree_path: candidate.tree_path,
    };
}
