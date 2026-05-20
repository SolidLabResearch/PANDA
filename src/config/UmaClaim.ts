import { Claim } from "../service/authorization/UserManagedAccessFetcher";
import jwt from "jsonwebtoken";

const DEFAULT_UMA_CLAIM_TOKEN = "http://localhost:3000/bob/profile/card#me";
const DEFAULT_UMA_CLAIM_TOKEN_FORMAT = "urn:solidlab:uma:claims:formats:jwt";
const DEFAULT_UMA_PURPOSE = "urn:client:benchmark";
const DEFAULT_UMA_JWT_SECRET = "ceci n'est pas un secret";

const UMA_WEBID_CLAIM_KEY = "urn:solidlab:uma:claims:types:webid";
const UMA_PURPOSE_CLAIM_KEY = "http://www.w3.org/ns/odrl/2/purpose";

function shouldLogUmaClaimDetails(): boolean {
    return process.env.NODE_ENV !== "production" || process.env.UMA_TRACE_TIMINGS === "1";
}

export function getUmaClaim(): Claim {
    const token_format = process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT || DEFAULT_UMA_CLAIM_TOKEN_FORMAT;
    const webid = process.env.PANDA_UMA_CLAIM_WEBID || process.env.PANDA_UMA_CLAIM_TOKEN || DEFAULT_UMA_CLAIM_TOKEN;

    if (token_format === "urn:solidlab:uma:claims:formats:webid") {
        return {
            token: webid,
            token_format,
        };
    }

    if (process.env.PANDA_UMA_CLAIM_TOKEN) {
        return {
            token: process.env.PANDA_UMA_CLAIM_TOKEN,
            token_format,
        };
    }

    const purpose = process.env.PANDA_UMA_CLAIM_PURPOSE || DEFAULT_UMA_PURPOSE;
    const jwtSecret = process.env.PANDA_UMA_CLAIM_JWT_SECRET || DEFAULT_UMA_JWT_SECRET;

    const payload = {
        [UMA_WEBID_CLAIM_KEY]: webid,
        [UMA_PURPOSE_CLAIM_KEY]: purpose,
    };

    if (shouldLogUmaClaimDetails()) {
        console.log("[UMA][claim] Building JWT claim payload", payload);
    }

    const token = jwt.sign(payload, jwtSecret, { algorithm: "HS256" });

    return {
        token,
        token_format,
    };
}
