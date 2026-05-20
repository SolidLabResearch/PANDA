import jwt from 'jsonwebtoken';
import { getUmaClaim } from './UmaClaim';

describe('getUmaClaim', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.PANDA_UMA_CLAIM_TOKEN;
        delete process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT;
        delete process.env.PANDA_UMA_CLAIM_WEBID;
        delete process.env.PANDA_UMA_CLAIM_PURPOSE;
        delete process.env.PANDA_UMA_CLAIM_JWT_SECRET;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('builds jwt claim by default with webid and odrl purpose', () => {
        const claim = getUmaClaim();
        expect(claim.token_format).toBe('urn:solidlab:uma:claims:formats:jwt');

        const decoded = jwt.verify(claim.token, "ceci n'est pas un secret") as Record<string, string>;
        expect(decoded['urn:solidlab:uma:claims:types:webid']).toBe('http://localhost:3000/bob/profile/card#me');
        expect(decoded['http://www.w3.org/ns/odrl/2/purpose']).toBe('urn:client:benchmark');
    });

    test('uses configured webid and purpose in jwt claims', () => {
        process.env.PANDA_UMA_CLAIM_WEBID = 'http://localhost:3000/alice/profile/card#me';
        process.env.PANDA_UMA_CLAIM_PURPOSE = 'urn:client:custom-purpose';
        process.env.PANDA_UMA_CLAIM_JWT_SECRET = 'custom-secret';

        const claim = getUmaClaim();
        const decoded = jwt.verify(claim.token, 'custom-secret') as Record<string, string>;

        expect(decoded['urn:solidlab:uma:claims:types:webid']).toBe('http://localhost:3000/alice/profile/card#me');
        expect(decoded['http://www.w3.org/ns/odrl/2/purpose']).toBe('urn:client:custom-purpose');
    });

    test('supports legacy webid claim format', () => {
        process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT = 'urn:solidlab:uma:claims:formats:webid';
        process.env.PANDA_UMA_CLAIM_WEBID = 'http://localhost:3000/carol/profile/card#me';

        const claim = getUmaClaim();

        expect(claim.token_format).toBe('urn:solidlab:uma:claims:formats:webid');
        expect(claim.token).toBe('http://localhost:3000/carol/profile/card#me');
    });
});
