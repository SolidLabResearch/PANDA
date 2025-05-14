import { fetch } from 'cross-fetch';
import { TokenManagerService } from './TokenManagerService';
import { Claim, parseAuthenticateHeader } from './UserManagedAccessFetcher';

/**
 * UMA Fetcher that first attempts to reuse a previously issued access token
 * stored in the TokenManagerService before falling back to the UMA authorization flow.
 */
export class ReuseTokenUMAFetcher {
    private readonly tokenManagerService: TokenManagerService;
    private readonly claim: Claim;

    constructor(claim: Claim) {
        this.claim = claim;
        this.tokenManagerService = TokenManagerService.getInstance();
    }

    public async fetch(url: string, init: RequestInit = {}): Promise<Response> {
        console.log(`[Fetcher] Attempting to fetch: ${url}`);

        // Step 0: Try stored token first (check for existing token in cache)
        let tokenInfo;
        try {
            tokenInfo = this.tokenManagerService.getAccessToken(url);
        } catch (err) {
            console.warn(`[Fetcher] No stored token for ${url}, proceeding with UMA flow.`);
        }

        if (tokenInfo) {
            // Check if we have a valid access token in the cache
            if (tokenInfo.access_token && tokenInfo.token_type) {
                const headers = new Headers(init.headers);
                headers.set('Authorization', `${tokenInfo.token_type} ${tokenInfo.access_token}`);

                try {
                    const response = await fetch(url, { ...init, headers });
                    console.log(`[Fetcher] Response from stored token fetch: ${response.status}`);

                    if (response.ok) {
                        console.log(`[Fetcher] Stored token succeeded for ${url}`);
                        return response;
                    }

                    if (response.status !== 401) {
                        console.warn(`[Fetcher] Stored token failed, status: ${response.status}`);
                        return response;
                    }

                    console.warn(`[Fetcher] Stored token rejected (401), falling back to UMA flow.`);
                } catch (err) {
                    console.error(`[Fetcher] Error using stored token:`, err);
                }
            }
        }

        // Step 1: Attempt UMA flow only if necessary (token missing or expired)
        let noTokenResponse: Response;
        try {
            console.log(`[Fetcher] Attempting tokenless request to get challenge.`);
            noTokenResponse = await fetch(url, init);
        } catch (err) {
            console.error(`[Fetcher] Network error during tokenless request:`, err);
            throw err;
        }

        console.log(`[Fetcher] Tokenless request response status: ${noTokenResponse.status}`);
        if (noTokenResponse.ok) {
            console.log(`[Fetcher] No token required for ${url}`);
            return noTokenResponse;
        }

        let tokenEndpoint: string, ticket: string;
        try {
            ({ tokenEndpoint, ticket } = parseAuthenticateHeader(noTokenResponse.headers));
            console.log(`[Fetcher] Parsed token endpoint: ${tokenEndpoint}`);
            console.log(`[Fetcher] Parsed ticket: ${ticket}`);
        } catch (err) {
            console.error(`[Fetcher] Failed to parse WWW-Authenticate header:`, err);
            throw err;
        }

        // Step 2: Check if the ticket has already been used recently (to avoid multiple RPT requests for the same ticket)
        const existingRPT = this.tokenManagerService.getRPT(ticket);
        if (existingRPT) {
            console.log(`[Fetcher] Using previously cached RPT.`);
            const headers = new Headers(init.headers);
            headers.set('Authorization', `${existingRPT.token_type} ${existingRPT.access_token}`);

            try {
                console.log(`[Fetcher] Final request with cached RPT.`);
                return await fetch(url, { ...init, headers });
            } catch (err) {
                console.error(`[Fetcher] Final fetch with cached RPT failed:`, err);
                throw err;
            }
        }

        // Step 3: Request RPT from the token endpoint if not already cached
        const rptRequestBody = {
            grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
            ticket,
            claim_token: this.claim.token,
            claim_token_format: this.claim.token_format,
        };

        console.log(rptRequestBody);
        

        let rptResponse: Response;
        try {
            console.log(`[Fetcher] Requesting RPT from token endpoint.`);
            rptResponse = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(rptRequestBody),
            });
        } catch (err) {
            console.error(`[Fetcher] Failed to request RPT:`, err);
            throw err;
        }

        if (!rptResponse.ok) {
            console.error(`[Fetcher] Failed to obtain RPT: ${rptResponse.status}`);
            return rptResponse;
        }

        const { access_token, token_type } = await rptResponse.json();

        console.log(`[Fetcher] Received RPT - Token Type: ${token_type}`);

        // Store the RPT for future use
        this.tokenManagerService.setAccessToken(url, access_token, token_type);
        this.tokenManagerService.setRPT(ticket, { access_token, token_type });

        const headers = new Headers(init.headers);
        headers.set('Authorization', `${token_type} ${access_token}`);

        try {
            console.log(`[Fetcher] Final request with RPT.`);
            return await fetch(url, { ...init, headers });
        } catch (err) {
            console.error(`[Fetcher] Final fetch with RPT failed:`, err);
            throw err;
        }
    }

    public async preAuthorize(resource: string): Promise<void> {
        console.log(`[Fetcher] Pre-authorizing resource: ${resource}`);
        await this.fetch(resource, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/turtle',
            },
            body: `<https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <http://rdfs.org/ns/void#inDataset> <https://dahcc.idlab.ugent.be/Protego/_participant1> .
            <https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <https://saref.etsi.org/core/measurementMadeBy> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/E4.A03846.Accelerometer> .
            <https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <http://purl.org/dc/terms/isVersionOf> <https://saref.etsi.org/core/Measurement> .
            <https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <https://saref.etsi.org/core/relatesToProperty> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.acceleration.x> .
            <https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <https://saref.etsi.org/core/hasTimestamp> "2025-05-05T12:57:59.166Z" .
            <https://dahcc.idlab.ugent.be/Protego/_participant1/obs1> <https://saref.etsi.org/core/hasValue> "-22.0"^^<http://www.w3.org/2001/XMLSchema#float> .
            `
        });
    }
}
