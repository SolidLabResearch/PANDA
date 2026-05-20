#!/usr/bin/env node

const crypto = require('crypto');

const UMA_WEBID_CLAIM_KEY = 'urn:solidlab:uma:claims:types:webid';
const UMA_PURPOSE_CLAIM_KEY = 'http://www.w3.org/ns/odrl/2/purpose';
const UMA_JWT_CLAIM_FORMAT = 'urn:solidlab:uma:claims:formats:jwt';
const UMA_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:uma-ticket';

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const config = {
  resourceUrl: env('PANDA_UMA_RESOURCE', 'http://localhost:3000/alice/derived/latest'),
  jwtSecret: env('PANDA_UMA_CLAIM_JWT_SECRET', "ceci n'est pas un secret"),
  expectedPurpose: env('PANDA_UMA_EXPECTED_PURPOSE', 'urn:client:benchmark'),
  bobWebId: env('PANDA_UMA_BOB_WEBID', 'http://localhost:3000/bob/profile/card#me'),
  aliceWebId: env('PANDA_UMA_ALICE_WEBID', 'http://localhost:3000/alice/profile/card#me'),
  eveWebId: env('PANDA_UMA_EVE_WEBID', 'http://localhost:3000/eve/profile/card#me'),
  debug: ['1', 'true', 'yes', 'on'].includes(env('PANDA_UMA_PURPOSE_MATRIX_DEBUG', '0').toLowerCase()),
};

function parseAuthenticateHeader(headers) {
  const header = headers.get('WWW-Authenticate');
  if (!header) throw new Error('No WWW-Authenticate header');

  const headerWithoutScheme = header.replace(/^UMA\s+/i, '');
  const params = Object.fromEntries(
    headerWithoutScheme.split(/\s*,\s*/).map((param) => {
      const sep = param.indexOf('=');
      if (sep < 0) return [param.trim(), ''];
      const key = param.slice(0, sep).trim();
      const value = param.slice(sep + 1).trim().replace(/^"|"$/g, '');
      return [key, value];
    })
  );

  if (!params.as_uri || !params.ticket) {
    throw new Error(`Invalid UMA header: ${header}`);
  }

  return {
    ticket: params.ticket,
    tokenEndpoint: new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString(),
  };
}

function buildClaimPayload(webId, purpose) {
  const payload = { [UMA_WEBID_CLAIM_KEY]: webId };
  if (purpose !== undefined) payload[UMA_PURPOSE_CLAIM_KEY] = purpose;
  return payload;
}

function b64urlFromString(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function buildClaimToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = b64urlFromString(JSON.stringify(header));
  const encodedPayload = b64urlFromString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(signingInput)
    .digest('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${signingInput}.${signature}`;
}

function passFail(expectedAllow, tokenStatus, finalStatus) {
  const tokenAllowed = tokenStatus >= 200 && tokenStatus < 300;
  const finalAllowed = finalStatus >= 200 && finalStatus < 300;
  return (tokenAllowed && finalAllowed) === expectedAllow;
}

function denialStage(expectedAllow, tokenStatus, finalStatus) {
  if (expectedAllow) {
    if (tokenStatus < 200 || tokenStatus >= 300) return 'unexpected deny at token exchange';
    if (finalStatus < 200 || finalStatus >= 300) return 'unexpected deny at resource retry';
    return 'allowed';
  }
  if (tokenStatus < 200 || tokenStatus >= 300) return 'denied at token exchange';
  if (finalStatus < 200 || finalStatus >= 300) return 'denied at resource retry';
  return 'unexpected allow';
}

async function runCase(testCase) {
  const initial = await fetch(config.resourceUrl, { method: 'GET' });
  const { ticket, tokenEndpoint } = parseAuthenticateHeader(initial.headers);

  const claimPayload = buildClaimPayload(testCase.webId, testCase.purpose);
  console.log(`\n[CASE] ${testCase.name}`);
  console.log(`webid=${testCase.webId}`);
  console.log(`purpose=${testCase.purpose === undefined ? 'missing' : testCase.purpose}`);
  console.log(`decoded_jwt_payload_before_sign=${JSON.stringify(claimPayload)}`);

  const claimToken = buildClaimToken(claimPayload);
  if (config.debug) console.log(`signed_jwt=${claimToken}`);

  const tokenRes = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: UMA_GRANT_TYPE,
      ticket,
      claim_token: claimToken,
      claim_token_format: UMA_JWT_CLAIM_FORMAT,
    }),
  });

  let finalStatus = -1;
  if (tokenRes.ok) {
    const tokenBody = await tokenRes.json();
    const tokenType = tokenBody.token_type || 'Bearer';
    const accessToken = tokenBody.access_token;
    const finalRes = await fetch(config.resourceUrl, {
      method: 'GET',
      headers: { Authorization: `${tokenType} ${accessToken}` },
    });
    finalStatus = finalRes.status;
  }

  const ok = passFail(testCase.expectedAllow, tokenRes.status, finalStatus);
  const stage = denialStage(testCase.expectedAllow, tokenRes.status, finalStatus);

  console.log(`token_exchange_status=${tokenRes.status}`);
  console.log(`final_resource_status=${finalStatus === -1 ? 'not-attempted' : finalStatus}`);
  console.log(`result=${ok ? 'PASS' : 'FAIL'}`);
  console.log(`decision_path=${stage}`);

  return ok;
}

async function main() {
  const matrix = [
    { name: '1) Bob + expected purpose', webId: config.bobWebId, purpose: config.expectedPurpose, expectedAllow: true },
    { name: '2) Bob + missing purpose', webId: config.bobWebId, purpose: undefined, expectedAllow: false },
    { name: '3) Bob + wrong purpose', webId: config.bobWebId, purpose: 'urn:client:wrong', expectedAllow: false },
    { name: '4) Eve + expected purpose', webId: config.eveWebId, purpose: config.expectedPurpose, expectedAllow: false },
    { name: '5) Alice + missing purpose', webId: config.aliceWebId, purpose: undefined, expectedAllow: true },
  ];

  console.log('[UMA Purpose Enforcement Matrix]');
  console.log(`resource=${config.resourceUrl}`);
  console.log(`expected_purpose=${config.expectedPurpose}`);

  let passed = 0;
  for (const testCase of matrix) {
    try {
      const ok = await runCase(testCase);
      if (ok) passed += 1;
    } catch (err) {
      console.log(`\n[CASE] ${testCase.name}`);
      console.log('result=FAIL');
      console.log(`error=${err && err.message ? err.message : String(err)}`);
    }
  }

  console.log(`\nsummary=${passed}/${matrix.length} passed`);
  if (passed !== matrix.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
