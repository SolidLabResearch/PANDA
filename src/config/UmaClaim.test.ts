import jwt from 'jsonwebtoken';
import { getUmaClaim } from './UmaClaim';

const ORIGINAL_ENV = process.env;
const JWT_FORMAT = 'urn:solidlab:uma:claims:formats:jwt';
const WEBID_FORMAT = 'urn:solidlab:uma:claims:formats:webid';
const WEBID_KEY = 'urn:solidlab:uma:claims:types:webid';
const PURPOSE_KEY = 'http://www.w3.org/ns/odrl/2/purpose';

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PANDA_UMA_CLAIM_TOKEN;
    delete process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT;
    delete process.env.PANDA_UMA_CLAIM_WEBID;
    delete process.env.PANDA_UMA_CLAIM_PURPOSE;
    delete process.env.PANDA_UMA_CLAIM_JWT_SECRET;
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

describe('getUmaClaim', () => {
    it('returns a JWT claim by default with webid and ODRL purpose claims', () => {
        const claim = getUmaClaim();
        expect(claim.token_format).toBe(JWT_FORMAT);

        const decoded = jwt.verify(claim.token, "ceci n'est pas un secret") as Record<string, string>;
        expect(decoded[WEBID_KEY]).toBe('http://localhost:3000/bob/profile/card#me');
        expect(decoded[PURPOSE_KEY]).toBe('urn:client:benchmark');
    });

    it('uses configured webid and purpose when generating JWT claim', () => {
        process.env.PANDA_UMA_CLAIM_WEBID = 'http://localhost:3000/alice/profile/card#me';
        process.env.PANDA_UMA_CLAIM_PURPOSE = 'urn:client:custom-purpose';
        process.env.PANDA_UMA_CLAIM_JWT_SECRET = 'custom-secret';

        const claim = getUmaClaim();
        expect(claim.token_format).toBe(JWT_FORMAT);

        const decoded = jwt.verify(claim.token, 'custom-secret') as Record<string, string>;
        expect(decoded[WEBID_KEY]).toBe('http://localhost:3000/alice/profile/card#me');
        expect(decoded[PURPOSE_KEY]).toBe('urn:client:custom-purpose');
    });

    it('keeps old webid-only behavior when claim_token_format is webid', () => {
        process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT = WEBID_FORMAT;
        process.env.PANDA_UMA_CLAIM_WEBID = 'http://localhost:3000/demo/profile/card#me';

        const claim = getUmaClaim();

        expect(claim).toEqual({
            token: 'http://localhost:3000/demo/profile/card#me',
            token_format: WEBID_FORMAT,
        });
    });
});
