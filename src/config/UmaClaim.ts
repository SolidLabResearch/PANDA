import { Claim } from "../service/authorization/UserManagedAccessFetcher";

const DEFAULT_UMA_CLAIM_TOKEN = "http://localhost:3000/bob/profile/card#me";
const DEFAULT_UMA_CLAIM_TOKEN_FORMAT = "urn:solidlab:uma:claims:formats:webid";

export function getUmaClaim(): Claim {
    return {
        token: process.env.PANDA_UMA_CLAIM_TOKEN || DEFAULT_UMA_CLAIM_TOKEN,
        token_format: process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT || DEFAULT_UMA_CLAIM_TOKEN_FORMAT,
    };
}

