import * as default_json_props from './config/config.json';
import { parseReplayConfig } from './config/loadConfig';
import { ReplayOrchestrator } from './publishing/ReplayOrchestrator';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Starts the replay of observations.
 */
async function main() {
    const configPath = process.env.REPLAYER_CONFIG_PATH;
    const rawConfig = configPath
        ? JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'))
        : default_json_props;
    const config = parseReplayConfig(rawConfig);
    const replayOrchestrator = new ReplayOrchestrator(config);
    await replayOrchestrator.replay_observations();
}

main().then(() => {
    console.log(`Starting the replay of observations`);
    fs.appendFileSync('replayer-log.csv', `start_replayer,${new Date().getTime()}\n`);
});
