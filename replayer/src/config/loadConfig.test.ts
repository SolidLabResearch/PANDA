import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseReplayConfig } from './loadConfig';

function createDatasetFile(dir: string, fileName: string): string {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(
        filePath,
        '<http://example.org/obs-1> <https://saref.etsi.org/core/measurementMadeBy> <http://example.org/sensor-1> .\n' +
        '<http://example.org/obs-1> <https://saref.etsi.org/core/hasTimestamp> "2024-01-01T00:00:00.000Z" .\n',
    );
    return filePath;
}

describe('parseReplayConfig', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replayer-config-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('accepts the new streams format', () => {
        const fileA = createDatasetFile(tmpDir, 'a.nt');
        const config = parseReplayConfig({
            streams: [
                { location: 'http://localhost:3000/alice/acc-x/', file_location: fileA }
            ],
            frequency_event: 4,
            frequency_buffer: 4,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        });

        expect(config.streams).toHaveLength(1);
        expect(config.streams[0].location).toBe('http://localhost:3000/alice/acc-x/');
    });

    test('rejects stream entries missing location', () => {
        const fileA = createDatasetFile(tmpDir, 'a.nt');
        expect(() => parseReplayConfig({
            streams: [{ file_location: fileA }],
            frequency_event: 4,
            frequency_buffer: 4,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        })).toThrow(/location/);
    });

    test('rejects stream entries missing file_location', () => {
        expect(() => parseReplayConfig({
            streams: [{ location: 'http://localhost:3000/alice/acc-x/' }],
            frequency_event: 4,
            frequency_buffer: 4,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        })).toThrow(/file_location/);
    });

    test('fails clearly for invalid file path', () => {
        expect(() => parseReplayConfig({
            streams: [{ location: 'http://localhost:3000/alice/acc-x/', file_location: path.join(tmpDir, 'missing.nt') }],
            frequency_event: 4,
            frequency_buffer: 4,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        })).toThrow(/file does not exist/);
    });

    test('fails fast on legacy config shape', () => {
        const fileA = createDatasetFile(tmpDir, 'a.nt');
        expect(() => parseReplayConfig({
            locations: ['http://localhost:3000/alice/acc-x/'],
            file_location: fileA,
            frequency_event: 4,
            frequency_buffer: 4,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        })).toThrow(/legacy "locations \+ file_location" format/);
    });

    test('one broken stream is rejected without silent corruption', () => {
        const fileA = createDatasetFile(tmpDir, 'a.nt');
        expect(() => parseReplayConfig({
            streams: [
                { location: 'http://localhost:3000/alice/acc-x/', file_location: fileA },
                { location: 'http://localhost:3000/alice/acc-y/', file_location: path.join(tmpDir, 'missing.nt') }
            ],
            frequency_event: 4,
            frequency_buffer: 4,
            is_ldes: false,
            tree_path: 'https://saref.etsi.org/core/hasTimestamp'
        })).toThrow(/index 1/);
    });
});
