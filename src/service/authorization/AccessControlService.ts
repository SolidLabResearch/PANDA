import { makeAuthenticatedFetch } from "../../utils/authentication/CSSAuthentication";
import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { TokenManager } from "./TokenManager";

export class AccessControlService {
    public requesting_user: string;
    public patient_webID: string
    public token_manager: any;
    public requested_resource: string;
    public terms = {
        solid: {
            umaServer: 'http://www.w3.org/ns/solid/terms#umaServer',
            location: 'http://www.w3.org/ns/solid/terms#location',
            viewIndex: 'http://www.w3.org/ns/solid/terms#viewIndex',
            entry: 'http://www.w3.org/ns/solid/terms#entry',
        },
        scopes: {
            read: 'urn:example:css:modes:read',
        }
    }
    private valid_authentication_tokens = new Map<string, string>();

    constructor(requesting_user: string, requested_resource: string, patient_webID: string) {
        this.patient_webID = patient_webID;
        this.requested_resource = requested_resource;
        this.requesting_user = requesting_user;
        this.token_manager = new TokenManager();
    }

    public addAuthenticationToken(user_webId: string, token: string) {
        this.valid_authentication_tokens.set(user_webId, token);
    }

    public getAuthenticationToken(user_webId: string): string {
        const authentication_token = this.valid_authentication_tokens.get(user_webId);
        if (authentication_token) {
            return authentication_token;
        }
        else {
            throw new Error("No authentication token found for the user.");

        }
    }

    async fetchUMAResourceServer(patient_webId: string) {
        const patientProfile = await (await fetch(patient_webId)).json();
        const umaServer = patientProfile[this.terms.solid.umaServer];
        return umaServer;
    }

    async getPolicy(policy: string): Promise<string> {
        return policy;
    }

    async authorizeRequest(requesting_user: string, requested_resource: string, purposeForAccess: string, legalBasis: string): Promise<boolean> {
        const fetch_response = await fetch(requested_resource, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            }
        });
        const umaHeader = await fetch_response.headers.get('WWW-Authenticate');
        console.log(`The resource request is done without any authorization with the UMA flow. It should result in a 401 response with an ${umaHeader} header.`);
        let authorization_server_uri = umaHeader?.split('as_uri=')[1].split('"')[1];
        let authorization_ticket = umaHeader?.split('ticket=')[1].replace(/"/g, '');
        console.log(`The authorization server URI is ${authorization_server_uri} and the ticket is ${authorization_ticket}.`);
        if (!authorization_server_uri) {
            throw new Error(`authorization_server_uri is missing. Parsed from header: ${umaHeader}`);
        }
        let authorization_server_uma_config = await (await fetch(`${authorization_server_uri}/.well-known/uma2-configuration`)).json();
        const token_endpoint = authorization_server_uma_config.token_endpoint;

        const accessRequestWithoutODRLClaims = this.generateAccessRequestWithoutODRLClaims(requesting_user, requested_resource, authorization_ticket);

        const monitoringServiceNeedInfoResponse = await fetch(token_endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(accessRequestWithoutODRLClaims)
        });

        if (monitoringServiceNeedInfoResponse.status !== 403) {
            console.log(`The request is successful and the monitoring service is authorized to access the resource.`);
            return true;
        }

        else {
            const { ticket: authorization_ticket_updated, required_claims: monitoringServiceClaims } = await monitoringServiceNeedInfoResponse.json();
            authorization_ticket = authorization_ticket_updated;
            const claim_jwt_token = this.generateJWTToken(purposeForAccess, requesting_user, legalBasis);
            const accessRequestWithODRLClaims = this.generateAccessRequestWithODRLClaims(requesting_user, requested_resource, authorization_ticket, purposeForAccess, legalBasis, claim_jwt_token);
            const monitoringServiceNeedInfoResponseWithClaims = await fetch(token_endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify(accessRequestWithODRLClaims)
            });

            const tokenParameters = await monitoringServiceNeedInfoResponseWithClaims.json();

            const accessWithTokenResponse = await fetch(requested_resource, {
                headers: {
                    'Authorization': `${tokenParameters.token_type} ${tokenParameters.access_token}`
                }
            });

            if (accessWithTokenResponse.status === 200) {
                this.token_manager.setAccessToken(tokenParameters.access_token, tokenParameters.token_type);
                console.log(`The request is successful and the monitoring service is authorized to access the resource.`);
                return true;
            }
            else {
                console.log(`The request is unsuccessful and the monitoring service is not authorized to access the resource.`);
                return false;
            }
        }
    }

    generateAccessRequestWithoutODRLClaims(requesting_user: string, requested_resource: string, authorization_ticket: string | undefined) {
        const accessRequestWithoutODRLClaims = {
            "@context": "https://www.w3.org/ns/odrl.jsonld",
            "@type": "Request",
            profile: { "@id": "https://w3id.org/oac#" },
            uid: `http://example.org/monitoring-request/${randomUUID()}`,// A unique identifier for the request (e.g., a UUID)
            description: `Request of the aggregator to access to ${requested_resource}`,
            permission: [
                {
                    "@type": "Permission",
                    "uid": `http://example.org/monitoring-request-permission/${randomUUID()}`,
                    assigner: this.patient_webID,
                    assignee: requesting_user,
                    action: { "@id": "https://w3id.org/oac#read" },
                    target: requested_resource,
                }
            ],
            grant_type: "urn:ietf:params:oauth:grant-type:uma-ticket",
            ticket: authorization_ticket
        };
        return accessRequestWithoutODRLClaims;
    };

    generateAccessRequestWithODRLClaims(requesting_user: string, requested_resource: string, authorization_ticket: string | undefined, purposeForAccess: string, legalBasis: string, claim_jwt_token: string) {
        const accessRequestWithODRLClaims = {
            "@context": "https://www.w3.org/ns/odrl.jsonld",
            "@type": "Request",
            profile: { "@id": "https://w3id.org/oac#" },
            uid: `http://example.org/monitoring-request/${randomUUID()}`,// A unique identifier for the request (e.g., a UUID)
            description: "Request of the aggregator to access to the resource for monitoring purposes",
            permission: [{
                "@type": "Permission",
                "@id": `http://example.org/monitoring-request-permission/${randomUUID()}`,
                target: requested_resource,
                assigner: this.patient_webID,
                assignee: requesting_user,
                constraint: [
                    {
                        "@type": "Constraint",
                        "@id": `http://example.org/monitoring-request-permission-purpose/${randomUUID()}`,
                        leftOperand: "purpose",
                        operator: "eq",
                        rightOperand: `${purposeForAccess}`,
                    },
                    {
                        "@type": "Constraint",
                        "@id": `http://example.org/monitoring-request-permission-purpose/${randomUUID()}`,
                        leftOperand: { "@id": "https://w3id.org/oac#LegalBasis" },
                        operator: "eq",
                        rightOperand: `${legalBasis}`,
                    }
                ],
            }],
            claim_token: claim_jwt_token,
            claim_token_format: "urn:solidlab:uma:claims:formats:jwt",
            grant_type: "urn:ietf:params:oauth:grant-type:uma-ticket",
            ticket: authorization_ticket
        };

        return accessRequestWithODRLClaims;
    }

    generateJWTToken(purposeForAccess: string, requesting_user: string, legalBasis: string) {
        const data_request_claims: any = {
            "http://www.w3.org/ns/odrl/2/purpose": purposeForAccess,
            "urn:solidlab:uma:claims:types:webid": requesting_user,
            "https://w3id.org/oac#LegalBasis": legalBasis,
        }
        // Now Generating a JWT (HS256; secret: "ceci n'est pas un secret")
        const claim_jwt_token = jwt.sign(data_request_claims, 'ceci n\'est pas un secret', { algorithm: 'HS256' });
        return claim_jwt_token;
    }

    async authenticateRequest(requesting_user: string, requested_resource: string): Promise<boolean> {
        const user_authentication_token = this.getAuthenticationToken(requesting_user);
        if (user_authentication_token) {
            const authenticatedFetchRequest = await makeAuthenticatedFetch(user_authentication_token, fetch)
            const response = await authenticatedFetchRequest(requested_resource, {
                method: 'GET'
            });
            if (response.status === 200) {
                console.log(`The user ${requesting_user} is authenticated to access the resource ${requested_resource}.`);
                return true;
            }
            else {
                console.log(`The user ${requesting_user} is not authenticated to access the resource ${requested_resource}.`);
                return false;
            }
        }
        else {
            throw new Error("No authentication token found for the user. Please create an authentication CSS client credential token first.");
        }
    }

}

