import jwt from "jsonwebtoken";
import { Claim } from "../service/authorization/UserManagedAccessFetcher";

const DEFAULT_UMA_CLAIM_WEBID = "http://localhost:3000/bob/profile/card#me";
const DEFAULT_UMA_CLAIM_PURPOSE = "urn:client:benchmark";
const DEFAULT_UMA_CLAIM_TOKEN_FORMAT = "urn:solidlab:uma:claims:formats:jwt";
const DEFAULT_UMA_CLAIM_JWT_SECRET = "ceci n'est pas un secret";
const WEBID_CLAIM_KEY = "urn:solidlab:uma:claims:types:webid";
const ODRL_PURPOSE_CLAIM_KEY = "http://www.w3.org/ns/odrl/2/purpose";

function shouldLogUmaClaimDebug(): boolean {
    return process.env.NODE_ENV !== "production"
        || process.env.PANDA_BENCHMARK_MODE === "true"
        || process.env.UMA_TRACE_TIMINGS === "1";
}

export function getUmaClaim(): Claim {
    const tokenFormat = process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT || DEFAULT_UMA_CLAIM_TOKEN_FORMAT;

    if (tokenFormat === "urn:solidlab:uma:claims:formats:webid") {
        const webIdToken = process.env.PANDA_UMA_CLAIM_TOKEN || process.env.PANDA_UMA_CLAIM_WEBID || DEFAULT_UMA_CLAIM_WEBID;
        return {
            token: webIdToken,
            token_format: tokenFormat,
        };
    }

    if (tokenFormat !== "urn:solidlab:uma:claims:formats:jwt") {
        return {
            token: process.env.PANDA_UMA_CLAIM_TOKEN || process.env.PANDA_UMA_CLAIM_WEBID || DEFAULT_UMA_CLAIM_WEBID,
            token_format: tokenFormat,
        };
    }

    const webId = process.env.PANDA_UMA_CLAIM_WEBID || DEFAULT_UMA_CLAIM_WEBID;
    const purpose = process.env.PANDA_UMA_CLAIM_PURPOSE || DEFAULT_UMA_CLAIM_PURPOSE;
    const secret = process.env.PANDA_UMA_CLAIM_JWT_SECRET || DEFAULT_UMA_CLAIM_JWT_SECRET;

    const claimPayload = {
        [WEBID_CLAIM_KEY]: webId,
        [ODRL_PURPOSE_CLAIM_KEY]: purpose,
    };

    if (shouldLogUmaClaimDebug()) {
        console.log("[UMA Claim] Preparing JWT claim payload:", claimPayload);
        console.log("[UMA Claim] claim_token_format:", tokenFormat);
    }

    const token = process.env.PANDA_UMA_CLAIM_TOKEN || jwt.sign(claimPayload, secret, { algorithm: "HS256" });

    return {
        token,
        token_format: tokenFormat,
    };
}
