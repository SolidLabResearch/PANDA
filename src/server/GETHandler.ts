import { IncomingMessage, ServerResponse } from "http";
import fs from 'fs';
import { AuditLoggedQueryService } from "../service/query-registry/AuditLoggedQueryService";
/**
 * Class for handling the GET request from the client.
 * @class GETHandler
 */
export class GETHandler {
    /**
     * Handle the GET request from the client.
     * @static
     * @param {IncomingMessage} req - The request from the client.
     * @param {ServerResponse} res - The response to the client.
     * @param {AuditLoggedQueryService} query_registry - The AuditLoggedQueryService object.
     * @memberof GETHandler
     */
    public static async handle(req: IncomingMessage, res: ServerResponse, query_registry: AuditLoggedQueryService) {
        if (req.url !== undefined) {
            /**
             * The following API path of the Solid Stream Aggregator is used to clear all of the registered queries from the query registry.
             */
            if (req.url === '/clearAuditLoggedQueryService') {
                query_registry.delete_all_queries_from_the_registry();
                res.write('Query registry cleared');
            }
        }
        else {
            const endpoint = req.url;
            console.log('Endpoint: ' + endpoint);
            /**
             * The API path showcases a default HTML Page for the Solid Stream Aggregator.
             */
            const file = fs.readFileSync('dist/static/index.html');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.write(file.toString());
        }

    }

}
