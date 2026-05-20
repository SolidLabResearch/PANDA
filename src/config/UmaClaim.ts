import { Claim } from "../service/authorization/UserManagedAccessFetcher";
import jwt from "jsonwebtoken";

const DEFAULT_UMA_CLAIM_TOKEN = "http://localhost:3000/bob/profile/card#me";
const DEFAULT_UMA_CLAIM_TOKEN_FORMAT = "urn:solidlab:uma:claims:formats:jwt";
const DEFAULT_UMA_PURPOSE = "urn:client:benchmark";
const JWT_SECRET = "ceci n'est pas un secret";
const UMA_WEBID_CLAIM_KEY = "urn:solidlab:uma:claims:types:webid";
const ODRL_PURPOSE_CLAIM_KEY = "http://www.w3.org/ns/odrl/2/purpose";

function isTruthy(value: string | undefined): boolean {
    return ["1", "true", "yes", "on"].includes((value || "").toLowerCase());
}

export function getUmaClaim(): Claim {
    const configuredToken = process.env.PANDA_UMA_CLAIM_TOKEN;
    const configuredTokenFormat = process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT || DEFAULT_UMA_CLAIM_TOKEN_FORMAT;
    const webId = process.env.PANDA_UMA_CLAIM_WEBID || DEFAULT_UMA_CLAIM_TOKEN;
    const purpose = process.env.PANDA_UMA_CLAIM_PURPOSE || DEFAULT_UMA_PURPOSE;
    const useWebIdOnly = isTruthy(process.env.PANDA_UMA_WEBID_ONLY_CLAIM);

    // Backwards-compatible override: if PANDA_UMA_CLAIM_TOKEN is explicitly set, keep using it verbatim.
    if (configuredToken) {
        return {
            token: configuredToken,
            token_format: configuredTokenFormat,
        };
    }

    const claimPayload: Record<string, string> = {
        [UMA_WEBID_CLAIM_KEY]: webId,
    };
    if (!useWebIdOnly) {
        claimPayload[ODRL_PURPOSE_CLAIM_KEY] = purpose;
    }

    if (isTruthy(process.env.PANDA_UMA_DEBUG_CLAIMS) || process.env.NODE_ENV !== "production") {
        console.log("[UMA Claim] claim_token_format:", DEFAULT_UMA_CLAIM_TOKEN_FORMAT);
        console.log("[UMA Claim] JWT payload before signing:", claimPayload);
    }

    const token = jwt.sign(claimPayload, JWT_SECRET, { algorithm: "HS256" });
    return {
        token,
        token_format: DEFAULT_UMA_CLAIM_TOKEN_FORMAT,
    };
}
