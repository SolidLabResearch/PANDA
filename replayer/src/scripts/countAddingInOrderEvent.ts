import * as fs from 'fs';

interface LogEvent {
    timestamp: number;
    eventType: string;
    details: string;
}

function countAddingInOrderEvent(
    logFilePath: string,
    windowName: string,
    bounds: [number, number]
): number[] {
    const logData = fs.readFileSync(logFilePath, 'utf8');
    const lines = logData.split('\n');
    let count = 0;
    let ooo_count = 0;

    const boundsString = `[${bounds[0]},${bounds[1]})`;
    const windowString = `to the window ${windowName}`;

    for (const line of lines) {
        if (
            line.includes('adding_in_order_event') &&
            line.includes(boundsString) &&
            line.includes(windowString)
        ) {
            count++;
        }

        else if (
            line.includes('adding_out_of_order_event') &&
            line.includes(boundsString) &&
            line.includes(windowString)
        ){
            ooo_count++;
        }
    }

    return [count, ooo_count];
}

// Example usage
const logFilePath = '/home/kush/CSPARQLWindow.log';
const windowName = 'https://rsp.js/w1';
const bounds: [number, number] = [1732549800000, 1732549860000];

const eventCount = countAddingInOrderEvent(logFilePath, windowName, bounds);
console.log(`ordered, out of order events: ${eventCount}`);
