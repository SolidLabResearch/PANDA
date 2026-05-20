import jwt from 'jsonwebtoken';
import { Claim } from "../service/authorization/UserManagedAccessFetcher";

const UMA_WEBID_CLAIM_KEY = 'urn:solidlab:uma:claims:types:webid';
const UMA_PURPOSE_CLAIM_KEY = 'http://www.w3.org/ns/odrl/2/purpose';

const DEFAULT_UMA_CLAIM_TOKEN = 'http://localhost:3000/bob/profile/card#me';
const DEFAULT_UMA_CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';
const DEFAULT_UMA_CLAIM_PURPOSE = 'urn:client:benchmark';
const DEFAULT_UMA_CLAIM_TOKEN_FORMAT_JWT = 'urn:solidlab:uma:claims:formats:jwt';
const DEFAULT_UMA_CLAIM_JWT_SECRET = "ceci n'est pas un secret";

function isVerboseUmaClaimLoggingEnabled(): boolean {
    const env = (process.env.PANDA_UMA_DEBUG_CLAIMS ?? process.env.DEBUG_UMA_LATENCY ?? '').toLowerCase();
    return env === '1' || env === 'true' || env === 'yes' || env === 'on';
}

function buildJwtClaimToken(webId: string, purpose: string): string {
    const payload = {
        [UMA_WEBID_CLAIM_KEY]: webId,
        [UMA_PURPOSE_CLAIM_KEY]: purpose,
    };

    if (isVerboseUmaClaimLoggingEnabled()) {
        console.log('[UMA Claim] Building JWT claim payload', payload);
    }

    return jwt.sign(payload, process.env.PANDA_UMA_CLAIM_JWT_SECRET || DEFAULT_UMA_CLAIM_JWT_SECRET, { algorithm: 'HS256' });
}

export function getUmaClaim(): Claim {
    const configuredTokenFormat = process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT || DEFAULT_UMA_CLAIM_TOKEN_FORMAT;
    const webId = process.env.PANDA_UMA_CLAIM_WEBID || process.env.PANDA_UMA_CLAIM_TOKEN || DEFAULT_UMA_CLAIM_TOKEN;

    if (configuredTokenFormat === DEFAULT_UMA_CLAIM_TOKEN_FORMAT_JWT) {
        const purpose = process.env.PANDA_UMA_CLAIM_PURPOSE || DEFAULT_UMA_CLAIM_PURPOSE;
        const token = buildJwtClaimToken(webId, purpose);

        if (isVerboseUmaClaimLoggingEnabled()) {
            console.log('[UMA Claim] Using JWT claim token format for UMA token exchange', {
                claim_token_format: configuredTokenFormat,
                webid: webId,
                purpose,
            });
        }

        return {
            token,
            token_format: configuredTokenFormat,
        };
    }

    if (isVerboseUmaClaimLoggingEnabled()) {
        console.log('[UMA Claim] Using non-JWT UMA claim token format', {
            claim_token_format: configuredTokenFormat,
            webid: webId,
        });
    }

    return {
        token: process.env.PANDA_UMA_CLAIM_TOKEN || webId,
        token_format: configuredTokenFormat,
    };
}
