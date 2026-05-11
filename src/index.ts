import { HTTPServer } from "./server/HTTPServer";
import * as bunyan from 'bunyan';
import * as fs from 'fs';

function getTimestamp() {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}-${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}-${now.getSeconds().toString().padStart(2, '0')}`;
}

const timestamp = getTimestamp();

const log_file = fs.createWriteStream(`aggregator-${timestamp}.log`, { flags: 'a' });
const resource_used_log_file = process.env.PANDA_RESOURCE_USAGE_LOG_FILE || `aggregator_resource_used-${timestamp}.csv`;
const resource_usage_interval_ms = Number(process.env.PANDA_RESOURCE_USAGE_INTERVAL_MS || 500);
const logger = bunyan.createLogger({
    name: 'solid-stream-aggregator',
    streams: [
        {
            level: 'info',
            stream: log_file
        },
    ],
    serializers: {
        log: (log_data: any) => {
            return {
                ...log_data,
                query_id: log_data.query_id || 'no_query_id',
            }
        }
    }
});

interface MemoryUsage {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers?: number;
}

fs.writeFileSync(
    resource_used_log_file,
    'timestamp,cpu_user_microseconds,cpu_system_microseconds,rss_bytes,heap_total_bytes,heap_used_bytes,external_bytes,array_buffers_bytes\n'
);


function logCpuMemoryUsage() {
    const cpuUsage = process.cpuUsage(); // in microseconds
    const memoryUsage: MemoryUsage = process.memoryUsage(); // in bytes
    const timestamp = Date.now();
    const arrayBuffersBytes = typeof memoryUsage.arrayBuffers === 'number' ? memoryUsage.arrayBuffers : '';
    const externalBytes = typeof memoryUsage.external === 'number' ? memoryUsage.external : '';
    const logData = `${timestamp},${cpuUsage.user},${cpuUsage.system},${memoryUsage.rss},${memoryUsage.heapTotal},${memoryUsage.heapUsed},${externalBytes},${arrayBuffersBytes}\n`;
    fs.appendFileSync(resource_used_log_file, logData);
}

setInterval(logCpuMemoryUsage, Number.isFinite(resource_usage_interval_ms) && resource_usage_interval_ms > 0 ? resource_usage_interval_ms : 500);

const program = require('commander');

program
    .version('0.0.1')
    .description('A privacy preserved healthcare stream monitoring from Solid Pod(s) for anomaly detection')
    .name('privacy-preserved-healthcare-stream-monitoring')

program
    .command('monitoring')
    .description('Starting the privacy preserved healthcare stream monitoring system service.')
    .option(
        '-p, --port <port>',
        'The port of the REST HTTP server',
        '8080'
    )
    .option(
        '-ss --solid_server_url <SolidServer>',
        'The URL of the Solid Pod server where the streams are stored in a Solid Pod',
        'http://localhost:3000/'
    )
    .action(async (options: any) => {
        new HTTPServer(options.port, options.SolidServer, logger);
    });

program.parse();
