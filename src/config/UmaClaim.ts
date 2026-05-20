import jwt from 'jsonwebtoken';
import { Claim } from "../service/authorization/UserManagedAccessFetcher";

const UMA_WEBID_CLAIM_KEY = 'urn:solidlab:uma:claims:types:webid';
const UMA_PURPOSE_CLAIM_KEY = 'http://www.w3.org/ns/odrl/2/purpose';
const UMA_JWT_CLAIM_FORMAT = 'urn:solidlab:uma:claims:formats:jwt';
const UMA_WEBID_CLAIM_FORMAT = 'urn:solidlab:uma:claims:formats:webid';

const DEFAULT_UMA_CLAIM_WEBID = 'http://localhost:3000/bob/profile/card#me';
const DEFAULT_UMA_CLAIM_PURPOSE = 'urn:client:benchmark';
const DEFAULT_UMA_CLAIM_TOKEN_FORMAT = UMA_JWT_CLAIM_FORMAT;
const DEFAULT_UMA_CLAIM_JWT_SECRET = "ceci n'est pas un secret";

function isDebugClaimLoggingEnabled(): boolean {
    return process.env.BENCHMARK_TIMING === '1'
        || process.env.NODE_ENV === 'development'
        || process.env.PANDA_UMA_DEBUG_CLAIMS === '1';
}

function redactToken(token: string): string {
    if (token.length <= 24) {
        return token;
    }
    return `${token.slice(0, 12)}...${token.slice(-12)}`;
}

function buildJwtClaimToken(webId: string, purpose: string, secret: string): string {
    return jwt.sign(
        {
            [UMA_WEBID_CLAIM_KEY]: webId,
            [UMA_PURPOSE_CLAIM_KEY]: purpose,
        },
        secret,
        { algorithm: 'HS256' }
    );
}

export function getUmaClaim(): Claim {
    const tokenFormat = process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT || DEFAULT_UMA_CLAIM_TOKEN_FORMAT;

    if (tokenFormat === UMA_WEBID_CLAIM_FORMAT) {
        const webIdToken = process.env.PANDA_UMA_CLAIM_TOKEN || process.env.PANDA_UMA_CLAIM_WEBID || DEFAULT_UMA_CLAIM_WEBID;
        if (isDebugClaimLoggingEnabled()) {
            console.log(`[UMA][CLAIM] format=${tokenFormat} webid=${webIdToken} mode=webid-only`);
        }
        return {
            token: webIdToken,
            token_format: tokenFormat,
        };
    }

    if (process.env.PANDA_UMA_CLAIM_TOKEN) {
        if (isDebugClaimLoggingEnabled()) {
            console.log(`[UMA][CLAIM] format=${tokenFormat} mode=explicit-token token_preview=${redactToken(process.env.PANDA_UMA_CLAIM_TOKEN)}`);
        }
        return {
            token: process.env.PANDA_UMA_CLAIM_TOKEN,
            token_format: tokenFormat,
        };
    }

    const webId = process.env.PANDA_UMA_CLAIM_WEBID || DEFAULT_UMA_CLAIM_WEBID;
    const purpose = process.env.PANDA_UMA_CLAIM_PURPOSE || DEFAULT_UMA_CLAIM_PURPOSE;
    const secret = process.env.PANDA_UMA_CLAIM_JWT_SECRET || DEFAULT_UMA_CLAIM_JWT_SECRET;

    if (isDebugClaimLoggingEnabled()) {
        console.log(`[UMA][CLAIM] format=${tokenFormat} mode=generated-jwt claims=${JSON.stringify({
            [UMA_WEBID_CLAIM_KEY]: webId,
            [UMA_PURPOSE_CLAIM_KEY]: purpose,
        })}`);
    }

    return {
        token: buildJwtClaimToken(webId, purpose, secret),
        token_format: tokenFormat,
    };
}
