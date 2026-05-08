#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const { runDerivedPreflight } = require('../uma/preflight-derived');
const {
  repoRoot,
  siblingDefaults,
  resolveRepoPath,
  ensureRepoExists,
} = require('./workspace_paths');

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return NaN;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function startTrace(config, iteration, phase) {
  return {
    enabled: config.traceTimings,
    iteration,
    phase,
    started_at_ms: nowMs(),
    steps: [],
    http: [],
  };
}

function recordStep(trace, step, durationMs, extra = {}) {
  if (!trace?.enabled) return;
  trace.steps.push({
    step,
    duration_ms: Number(durationMs.toFixed(3)),
    kind: extra.kind || 'cpu',
    phase: extra.phase || 'unknown',
    ...(extra.meta ? { meta: extra.meta } : {}),
  });
}

async function timeAsync(trace, step, fn, extra = {}) {
  const start = nowMs();
  try {
    return await fn();
  } finally {
    recordStep(trace, step, nowMs() - start, extra);
  }
}

function timeSync(trace, step, fn, extra = {}) {
  const start = nowMs();
  try {
    return fn();
  } finally {
    recordStep(trace, step, nowMs() - start, extra);
  }
}

async function tracedFetch(trace, step, url, init = {}, extra = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const start = nowMs();
  const response = await fetch(url, init);
  const duration = nowMs() - start;
  recordStep(trace, step, duration, { kind: 'network', ...extra });
  if (trace?.enabled) {
    trace.http.push({
      step,
      phase: extra.phase || 'unknown',
      method,
      url,
      status: response.status,
      duration_ms: Number(duration.toFixed(3)),
    });
  }
  return response;
}

function classifyStepKind(step) {
  if (
    step.includes('jwt_verify') ||
    step.includes('signature_verify') ||
    step.includes('dpop_sign') ||
    step.includes('crypto')
  ) {
    return 'crypto';
  }
  if (step.includes('serialize') || step.includes('stringify')) return 'serialization';
  if (step.includes('deserialize') || step.includes('json_parse') || step.includes('header_parse')) {
    return 'deserialization';
  }
  return 'cpu';
}

function summarizeTrace(trace) {
  if (!trace?.enabled) return null;
  const totals = {
    network_ms: 0,
    cpu_ms: 0,
    serialization_ms: 0,
    deserialization_ms: 0,
    crypto_ms: 0,
  };

  const stepsByName = {};
  for (const event of trace.steps) {
    const kind = event.kind || classifyStepKind(event.step);
    if (kind === 'network') totals.network_ms += event.duration_ms;
    else if (kind === 'serialization') totals.serialization_ms += event.duration_ms;
    else if (kind === 'deserialization') totals.deserialization_ms += event.duration_ms;
    else if (kind === 'crypto') totals.crypto_ms += event.duration_ms;
    else totals.cpu_ms += event.duration_ms;

    stepsByName[event.step] = (stepsByName[event.step] || 0) + event.duration_ms;
  }

  const totalTrackedMs = Object.values(totals).reduce((sum, value) => sum + value, 0);

  return {
    ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v.toFixed(3))])),
    tracked_total_ms: Number(totalTrackedMs.toFixed(3)),
    http_round_trips: trace.http.length,
    http_round_trips_by_phase: trace.http.reduce((acc, call) => {
      acc[call.phase] = (acc[call.phase] || 0) + 1;
      return acc;
    }, {}),
    steps_by_name_ms: Object.fromEntries(
      Object.entries(stepsByName).map(([key, value]) => [key, Number(value.toFixed(3))])
    ),
  };
}

function aggregateStepStats(rows) {
  const measured = rows.filter((row) => row.phase === 'measured' && row.trace_summary?.steps_by_name_ms);
  const map = new Map();
  for (const row of measured) {
    for (const [step, duration] of Object.entries(row.trace_summary.steps_by_name_ms)) {
      const entry = map.get(step) || [];
      entry.push(duration);
      map.set(step, entry);
    }
  }

  const entries = Array.from(map.entries()).map(([step, durations]) => {
    const sorted = durations.slice().sort((a, b) => a - b);
    return {
      step,
      count: durations.length,
      avg_ms: Number(mean(durations).toFixed(3)),
      p95_ms: Number(percentile(sorted, 95).toFixed(3)),
      min_ms: Number(sorted[0].toFixed(3)),
      max_ms: Number(sorted[sorted.length - 1].toFixed(3)),
      repeated_per_iteration_avg: Number((durations.length / Math.max(1, measured.length)).toFixed(3)),
    };
  });

  entries.sort((a, b) => b.avg_ms - a.avg_ms);
  return entries;
}

function parseAuthenticateHeader(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) throw new Error('Missing WWW-Authenticate header');

  const headerWithoutScheme = wwwAuthenticateHeader.replace(/^UMA\s+/i, '');
  const params = Object.fromEntries(
    headerWithoutScheme.split(/\s*,\s*/).map((param) => {
      const separatorIndex = param.indexOf('=');
      if (separatorIndex < 0) return [param.trim(), ''];
      const key = param.slice(0, separatorIndex).trim();
      const value = param.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '');
      return [key, value];
    })
  );

  const asUri = params.as_uri;
  const ticket = params.ticket;

  if (!asUri || !ticket) {
    throw new Error(`Invalid UMA WWW-Authenticate header: ${wwwAuthenticateHeader}`);
  }

  const tokenEndpoint = new URL('token', asUri.endsWith('/') ? asUri : `${asUri}/`).toString();
  return { tokenEndpoint, ticket };
}

function isLocalUmaDemoResource(resourceUrl) {
  try {
    const parsed = new URL(resourceUrl);
    return parsed.hostname === 'localhost' && parsed.port === '3000';
  } catch {
    return false;
  }
}

function normalizeAsIssuer(issuer) {
  return issuer.replace(/\/+$/, '');
}

function runStrictPreflight(config) {
  const shouldRun = env('PANDA_UMA_STRICT_PREFLIGHT', 'true').toLowerCase() === 'true';
  if (!shouldRun) return;

  const preflightEnv = {
    ...process.env,
    PANDA_UMA_RESOURCE: config.resourceUrl,
    PANDA_UMA_CLAIM_TOKEN: config.claimToken,
    PANDA_UMA_REQUIRE_UMA_CHALLENGE: 'true',
    PANDA_UMA_REQUIRE_401_CHALLENGE: 'true',
    PANDA_UMA_REQUIRE_DENY_PATH: 'true',
    PANDA_UMA_REQUIRE_ODRL_PROOF: 'false',
    PANDA_UMA_DENY_CLAIM_TOKEN: env('PANDA_UMA_DENY_CLAIM_TOKEN', 'http://localhost:3000/demo/profile/card#me'),
    PANDA_UMA_WRONG_TARGET_RESOURCE: env('PANDA_UMA_WRONG_TARGET_RESOURCE', 'http://localhost:3000/alice/derived/acc-y/'),
  };

  const result = spawnSync('node', ['scripts/uma/smoke.js'], {
    cwd: process.cwd(),
    env: preflightEnv,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`Strict UMA preflight failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function inferOwnerWebId(resourceUrl) {
  const parsed = new URL(resourceUrl);
  const pod = parsed.pathname.split('/').filter(Boolean)[0];
  if (!pod) throw new Error(`Cannot infer pod owner from resource URL: ${resourceUrl}`);
  return `${parsed.origin}/${pod}/profile/card#me`;
}

function inferOwnerEmail(resourceUrl) {
  const parsed = new URL(resourceUrl);
  const pod = parsed.pathname.split('/').filter(Boolean)[0];
  if (!pod) throw new Error(`Cannot infer pod owner email from resource URL: ${resourceUrl}`);
  return `${pod}@example.org`;
}

function findLocalUmaDemoPaths() {
  const umaRoot = resolveRepoPath({
    cliValue: null,
    envVarName: 'UMA_REPO',
    defaultPath: siblingDefaults.umaRepo,
  });
  const source = path.join(umaRoot, 'demo', 'data');
  const target = path.join(umaRoot, 'packages', 'css', 'tmp');
  return { source, target };
}

function healLocalUmaDemoStorage(config) {
  if (!config.autoHealLocalStack || !isLocalUmaDemoResource(config.resourceUrl)) return false;
  const { source, target } = findLocalUmaDemoPaths();
  if (!fs.existsSync(source)) return false;

  // Replace runtime storage with known-good demo fixtures (same shape as yarn demo:setup).
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, force: true });
  return true;
}

async function ensureLocalUmaPatCredentials(config) {
  if (!config.autoHealLocalStack || !isLocalUmaDemoResource(config.resourceUrl)) return false;

  const resourceOrigin = new URL(config.resourceUrl).origin;
  const ownerWebId = config.ownerWebId || inferOwnerWebId(config.resourceUrl);
  const ownerEmail = config.ownerEmail || inferOwnerEmail(config.resourceUrl);
  const ownerPassword = config.ownerPassword;
  const asIssuer = normalizeAsIssuer(config.asIssuer);

  const accountIndex = await fetch(new URL('.account/', resourceOrigin).toString());
  if (!accountIndex.ok) {
    throw new Error(`Failed to discover account controls (${accountIndex.status}).`);
  }
  const accountIndexBody = await accountIndex.json();
  const loginUrl = accountIndexBody?.controls?.password?.login;
  if (!loginUrl) throw new Error('Account login control missing.');

  const loginResponse = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Account login failed (${loginResponse.status}) for ${ownerEmail}.`);
  }
  const loginBody = await loginResponse.json();
  const accountToken = loginBody.authorization;
  if (!accountToken) throw new Error('Account login did not return authorization token.');

  const authedIndexResponse = await fetch(new URL('.account/', resourceOrigin).toString(), {
    headers: { authorization: `CSS-Account-Token ${accountToken}` },
  });
  if (!authedIndexResponse.ok) {
    throw new Error(`Failed to load authenticated account controls (${authedIndexResponse.status}).`);
  }
  const authedIndex = await authedIndexResponse.json();
  const patUrl = authedIndex?.controls?.account?.pat;
  if (!patUrl) throw new Error('PAT endpoint missing from account controls.');

  const asConfigResponse = await fetch(`${asIssuer}/.well-known/uma2-configuration`);
  if (!asConfigResponse.ok) {
    throw new Error(`Failed UMA AS discovery (${asConfigResponse.status}) at ${asIssuer}.`);
  }
  const asConfig = await asConfigResponse.json();
  const registrationEndpoint = asConfig.registration_endpoint;
  if (!registrationEndpoint) throw new Error(`UMA AS discovery did not provide registration_endpoint.`);

  let registrationResponse = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: {
      authorization: `WebID ${encodeURIComponent(ownerWebId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ client_uri: resourceOrigin }),
  });

  // Existing registration responses do not include credentials; force a new registration URI.
  if (registrationResponse.status === 409) {
    registrationResponse = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: {
        authorization: `WebID ${encodeURIComponent(ownerWebId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client_uri: `${resourceOrigin}/?benchmark=${Date.now()}` }),
    });
  }

  if (!registrationResponse.ok) {
    const body = await registrationResponse.text().catch(() => '');
    throw new Error(`UMA client registration failed (${registrationResponse.status}): ${body}`);
  }

  const registration = await registrationResponse.json();
  if (!registration.client_id || !registration.client_secret) {
    throw new Error('UMA registration response missing client credentials.');
  }

  const patResponse = await fetch(patUrl, {
    method: 'POST',
    headers: {
      authorization: `CSS-Account-Token ${accountToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: registration.client_id,
      secret: registration.client_secret,
      issuer: asIssuer,
    }),
  });

  if (!patResponse.ok) {
    const body = await patResponse.text().catch(() => '');
    throw new Error(`PAT registration failed (${patResponse.status}): ${body}`);
  }

  return {
    ownerWebId,
    ownerEmail,
    asIssuer,
    registrationEndpoint,
    tokenEndpoint: asConfig.token_endpoint,
    resourceRegistrationEndpoint: asConfig.resource_registration_endpoint,
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
  };
}

function inferResourceScopes() {
  return [
    'urn:example:css:modes:read',
    'urn:example:css:modes:append',
    'urn:example:css:modes:create',
    'urn:example:css:modes:delete',
    'urn:example:css:modes:write',
  ];
}

function bodySignalsUnknownUmaRegistration(status, bodyText) {
  if (status !== 500 && status !== 403 && status !== 400) return false;
  return /Unknown UMA ID|Unknown PAT|Error while requesting UMA header/i.test(bodyText || '');
}

const localPolicySeedCache = new Set();

function isLikelyWebId(value) {
  return /^https?:\/\/.+#.+/.test(value || '');
}

async function seedLocalAllowReadPolicy(config) {
  if (!config.autoHealLocalStack || !isLocalUmaDemoResource(config.resourceUrl)) return false;

  const claimWebId = decodeURIComponent(config.claimToken || '');
  if (!isLikelyWebId(claimWebId)) return false;

  const ownerWebId = config.ownerWebId || inferOwnerWebId(config.resourceUrl);
  const cacheKey = `${config.resourceUrl}|${claimWebId}|${ownerWebId}`;
  if (localPolicySeedCache.has(cacheKey)) return true;

  const policyEndpoint = `${normalizeAsIssuer(config.asIssuer)}/policies`;
  const policyNamespace = `http://example.org/benchmark/${randomUUID()}#`;
  const policy = `
@prefix ex: <${policyNamespace}> .
PREFIX oac: <https://w3id.org/oac#>
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>

ex:usagePolicy a odrl:Agreement ;
    odrl:uid ex:usagePolicy ;
    odrl:profile oac: ;
    odrl:permission ex:permission .

ex:permission a odrl:Permission ;
    odrl:action odrl:read ;
    odrl:target <${config.resourceUrl}> ;
    odrl:assigner <${ownerWebId}> ;
    odrl:assignee <${claimWebId}> .
`.trim();

  const response = await fetch(policyEndpoint, {
    method: 'POST',
    headers: {
      authorization: `WebID ${encodeURIComponent(ownerWebId)}`,
      'content-type': 'text/turtle',
    },
    body: policy,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to seed benchmark policy (${response.status}) at ${policyEndpoint}: ${body}`);
  }

  localPolicySeedCache.add(cacheKey);
  return true;
}

async function ensureLocalUmaResourceRegistration(config) {
  if (!config.autoHealLocalStack || !isLocalUmaDemoResource(config.resourceUrl)) return false;
  const context = await ensureLocalUmaPatCredentials(config);
  if (!context || !context.tokenEndpoint || !context.resourceRegistrationEndpoint) return false;

  const basic = Buffer.from(`${context.clientId}:${context.clientSecret}`).toString('base64');
  const patResponse = await fetch(context.tokenEndpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=uma_protection',
  });

  if (!patResponse.ok) {
    const body = await patResponse.text().catch(() => '');
    throw new Error(`Failed to mint UMA protection token (${patResponse.status}): ${body}`);
  }

  const patPayload = await patResponse.json();
  const accessToken = patPayload.access_token;
  const tokenType = patPayload.token_type || 'Bearer';
  if (!accessToken) throw new Error('UMA protection token response missing access_token.');

  const registrationBody = {
    name: config.resourceUrl,
    resource_scopes: inferResourceScopes(),
  };

  const registrationResponse = await fetch(context.resourceRegistrationEndpoint, {
    method: 'POST',
    headers: {
      authorization: `${tokenType} ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(registrationBody),
  });

  if (registrationResponse.status === 409) return true;
  if (!registrationResponse.ok) {
    const body = await registrationResponse.text().catch(() => '');
    throw new Error(`Failed to register UMA resource (${registrationResponse.status}): ${body}`);
  }
  return true;
}

async function refreshChallenge(config) {
  const response = await fetch(config.resourceUrl, { method: config.resourceMethod });
  const header = response.headers.get('WWW-Authenticate');
  if (!header) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Unable to refresh UMA ticket after local heal (status ${response.status}). ` +
      `${body ? `Body: ${body}` : 'No response body.'}`
    );
  }
  return parseAuthenticateHeader(header);
}

function createTokenRequestBody(config, ticket, trace) {
  if (config.tokenRequestFilePath) {
    const raw = timeSync(trace, 'token_exchange.token_request.read_file', () =>
      fs.readFileSync(config.tokenRequestFilePath, 'utf8'), {
      phase: 'token_exchange',
      kind: 'deserialization',
    });
    const fromFile = timeSync(trace, 'token_exchange.token_request.json_parse_file', () => JSON.parse(raw), {
      phase: 'token_exchange',
      kind: 'deserialization',
    });
    return {
      ...fromFile,
      grant_type: fromFile.grant_type || 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
    };
  }

  if (config.tokenRequestMode === 'odrl') {
    const inferredAssigner = config.odrlAssigner || inferOwnerWebId(config.resourceUrl);
    const inferredAssignee = config.odrlAssignee || decodeURIComponent(config.claimToken || '');
    const permission = {
      '@type': 'Permission',
      uid: `urn:uuid:${randomUUID()}`,
      target: config.resourceUrl,
      action: { '@id': config.odrlAction },
      assigner: inferredAssigner,
      assignee: inferredAssignee,
    };

    return {
      '@context': 'http://www.w3.org/ns/odrl.jsonld',
      '@type': 'Request',
      profile: { '@id': config.odrlProfile },
      uid: `urn:uuid:${randomUUID()}`,
      description: config.odrlDescription,
      permission: [permission],
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: config.claimToken || undefined,
      claim_token_format: config.claimTokenFormat,
    };
  }

  const encodedClaimToken = timeSync(
    trace,
    'token_exchange.claim_token.encode_uri_component',
    () => encodeURIComponent(config.claimToken),
    { phase: 'token_exchange', kind: 'cpu' }
  );

  return {
    grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
    ticket,
    claim_token: encodedClaimToken,
    claim_token_format: config.claimTokenFormat,
  };
}

async function postPolicyIfConfigured(config, trace) {
  if (!config.includePolicyPost) return { policyPostMs: 0, policyPostStatus: null };

  const response = await tracedFetch(trace, 'policy_post.http_post', config.policyContainerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': config.policyContentType,
      ...(config.policyAuthorizationHeader ? { Authorization: config.policyAuthorizationHeader } : {}),
    },
    body: config.policyBody,
  }, { phase: 'policy_post' });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Policy POST failed (${response.status}): ${body}`);
  }

  let policyPostMs = 0;
  if (trace?.steps?.length) {
    for (let i = trace.steps.length - 1; i >= 0; i -= 1) {
      if (trace.steps[i].step === 'policy_post.http_post') {
        policyPostMs = trace.steps[i].duration_ms;
        break;
      }
    }
  }

  return {
    policyPostMs,
    policyPostStatus: response.status,
  };
}

async function runIteration(config, iteration, phase) {
  const trace = startTrace(config, iteration, phase);
  const runStartMs = nowMs();
  let initialChallengeMs = 0;
  let tokenExchangeMs = 0;
  let authorizedMs = 0;
  let challengeStatus = null;
  let tokenStatus = null;
  let authorizedStatus = null;
  let note = 'ok';

  const policyResult = await postPolicyIfConfigured(config, trace);

  const applyAuthorizedRequest = async (
    accessToken,
    tokenType,
    stepPrefix = 'authorized_request',
    options = {}
  ) => {
    const { allowNonOk = false } = options;
    const authorizedStartMs = nowMs();
    const authorizedResponse = await tracedFetch(
      trace,
      `${stepPrefix}.resource_request`,
      config.resourceUrl,
      {
        method: config.resourceMethod,
        headers: { Authorization: `${tokenType} ${accessToken}` },
      },
      { phase: 'authorized_request' }
    );
    const authorizedDoneMs = nowMs();
    authorizedMs = authorizedDoneMs - authorizedStartMs;
    authorizedStatus = authorizedResponse.status;

    if (allowNonOk && !authorizedResponse.ok) {
      return authorizedResponse;
    }

    if (!authorizedResponse.ok) {
      const body = await timeAsync(
        trace,
        `${stepPrefix}.error_response.text_deserialize`,
        () => authorizedResponse.text().catch(() => ''),
        { phase: 'authorized_request', kind: 'deserialization' }
      );
      throw new Error(`Authorized request failed (${authorizedResponse.status}): ${body}`);
    }
    return authorizedResponse;
  };

  if (config.reuseAccessToken && config.cachedAccessToken && config.cachedTokenType) {
    const reuseResponse = await applyAuthorizedRequest(
      config.cachedAccessToken,
      config.cachedTokenType,
      'token_reuse_probe',
      { allowNonOk: true }
    );
    if (!reuseResponse.ok && (reuseResponse.status === 401 || reuseResponse.status === 403)) {
      note = 'token-reuse-miss-fallback';
    }
    if (authorizedStatus >= 200 && authorizedStatus < 300) {
      const traceSummary = summarizeTrace(trace);
      return {
        iteration,
        phase,
        challenge_status: null,
        token_status: null,
        authorized_status: authorizedStatus,
        policy_post_latency_ms: policyResult.policyPostMs,
        initial_challenge_latency_ms: 0,
        token_exchange_latency_ms: 0,
        authorized_request_latency_ms: authorizedMs,
        total_flow_latency_ms: nowMs() - runStartMs,
        note: 'token-reused',
        trace_summary: traceSummary,
        trace,
      };
    }
  }

  const initialStartMs = nowMs();
  let initialResponse = await tracedFetch(
    trace,
    'initial_challenge.resource_request_without_token',
    config.resourceUrl,
    { method: config.resourceMethod },
    { phase: 'initial_challenge' }
  );
  if (!initialResponse.ok && !initialResponse.headers.get('WWW-Authenticate')) {
    const healed = timeSync(trace, 'initial_challenge.local_storage_heal', () => healLocalUmaDemoStorage(config), {
      phase: 'initial_challenge',
      kind: 'cpu',
    });
    if (healed) {
      await timeAsync(trace, 'initial_challenge.pat_credentials_refresh', () => ensureLocalUmaPatCredentials(config), {
        phase: 'initial_challenge',
        kind: 'network',
      });
      initialResponse = await tracedFetch(
        trace,
        'initial_challenge.resource_request_without_token_after_heal',
        config.resourceUrl,
        { method: config.resourceMethod },
        { phase: 'initial_challenge' }
      );
    }
  }
  const initialDoneMs = nowMs();
  initialChallengeMs = initialDoneMs - initialStartMs;
  challengeStatus = initialResponse.status;

  if (initialResponse.ok) {
    if (config.requireUmaChallenge) {
      throw new Error(
        `Resource responded with ${initialResponse.status} without UMA challenge. ` +
        `Use a UMA-protected resource (for PANDA+EYE, prefer a protected derived/private target).`
      );
    }
    note = 'resource-was-public';
    const traceSummary = summarizeTrace(trace);
    return {
      iteration,
      phase,
      challenge_status: challengeStatus,
      token_status: null,
      authorized_status: challengeStatus,
      policy_post_latency_ms: policyResult.policyPostMs,
      initial_challenge_latency_ms: initialChallengeMs,
      token_exchange_latency_ms: 0,
      authorized_request_latency_ms: 0,
      total_flow_latency_ms: nowMs() - runStartMs,
      note,
      trace_summary: traceSummary,
      trace,
    };
  }

  const tryTokenExchange = async (tokenEndpoint, ticket, stepPrefix = 'token_exchange') => {
    const tokenRequestBody = timeSync(
      trace,
      `${stepPrefix}.build_token_request_body`,
      () => createTokenRequestBody(config, ticket, trace),
      { phase: 'token_exchange', kind: 'cpu' }
    );
    const requestBody = timeSync(
      trace,
      `${stepPrefix}.request_body_json_serialize`,
      () => JSON.stringify(tokenRequestBody),
      { phase: 'token_exchange', kind: 'serialization' }
    );

    const tokenStartMs = nowMs();
    const tokenResponse = await tracedFetch(
      trace,
      `${stepPrefix}.http_post_token`,
      tokenEndpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      },
      { phase: 'token_exchange' }
    );
    tokenExchangeMs = nowMs() - tokenStartMs;
    tokenStatus = tokenResponse.status;

    if (!tokenResponse.ok) {
      const body = await timeAsync(
        trace,
        `${stepPrefix}.error_response.text_deserialize`,
        () => tokenResponse.text().catch(() => ''),
        { phase: 'token_exchange', kind: 'deserialization' }
      );

      if (
        tokenResponse.status === 403 &&
        /Request denied/i.test(body) &&
        (await timeAsync(trace, `${stepPrefix}.seed_local_allow_read_policy`, () => seedLocalAllowReadPolicy(config), {
          phase: 'token_exchange',
          kind: 'network',
        }))
      ) {
        const refreshedChallenge = await timeAsync(
          trace,
          `${stepPrefix}.refresh_challenge`,
          () => refreshChallenge(config),
          { phase: 'token_exchange', kind: 'network' }
        );
        const retried = await tryTokenExchange(
          refreshedChallenge.tokenEndpoint,
          refreshedChallenge.ticket,
          `${stepPrefix}.retry`
        );
        return retried;
      }
      throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`);
    }

    const tokenPayload = await timeAsync(
      trace,
      `${stepPrefix}.success_response.json_deserialize`,
      () => tokenResponse.json(),
      { phase: 'token_exchange', kind: 'deserialization' }
    );
    const accessToken = tokenPayload.access_token;
    const tokenType = tokenPayload.token_type || 'Bearer';

    if (!accessToken) throw new Error('Token response missing access_token');
    return { accessToken, tokenType };
  };

  let wwwAuthenticateHeader = initialResponse.headers.get('WWW-Authenticate');
  if (!wwwAuthenticateHeader) {
    let body = await timeAsync(
      trace,
      'initial_challenge.error_response.text_deserialize',
      () => initialResponse.text().catch(() => ''),
      { phase: 'initial_challenge', kind: 'deserialization' }
    );

    if (bodySignalsUnknownUmaRegistration(initialResponse.status, body)) {
      const healed = await timeAsync(
        trace,
        'initial_challenge.resource_registration_heal',
        () => ensureLocalUmaResourceRegistration(config),
        { phase: 'initial_challenge', kind: 'network' }
      );
      if (healed) {
        initialResponse = await tracedFetch(
          trace,
          'initial_challenge.resource_request_after_registration_heal',
          config.resourceUrl,
          { method: config.resourceMethod },
          { phase: 'initial_challenge' }
        );
        wwwAuthenticateHeader = initialResponse.headers.get('WWW-Authenticate');
        if (wwwAuthenticateHeader) {
          const { tokenEndpoint, ticket } = timeSync(
            trace,
            'initial_challenge.www_authenticate_header_parse_after_heal',
            () => parseAuthenticateHeader(wwwAuthenticateHeader),
            { phase: 'initial_challenge', kind: 'deserialization' }
          );
          const { accessToken, tokenType } = await tryTokenExchange(tokenEndpoint, ticket);
          config.cachedAccessToken = accessToken;
          config.cachedTokenType = tokenType;
          await applyAuthorizedRequest(accessToken, tokenType);
          const traceSummary = summarizeTrace(trace);
          return {
            iteration,
            phase,
            challenge_status: challengeStatus,
            token_status: tokenStatus,
            authorized_status: authorizedStatus,
            policy_post_latency_ms: policyResult.policyPostMs,
            initial_challenge_latency_ms: initialChallengeMs,
            token_exchange_latency_ms: tokenExchangeMs,
            authorized_request_latency_ms: authorizedMs,
            total_flow_latency_ms: nowMs() - runStartMs,
            note,
            trace_summary: traceSummary,
            trace,
          };
        }
        body = await timeAsync(
          trace,
          'initial_challenge.error_response.text_deserialize_after_heal',
          () => initialResponse.text().catch(() => body),
          { phase: 'initial_challenge', kind: 'deserialization' }
        );
      }
    }
    throw new Error(
      `Missing WWW-Authenticate header (status ${initialResponse.status}). ` +
      `${body ? `Body: ${body}` : 'No response body.'}`
    );
  }

  const { tokenEndpoint, ticket } = timeSync(
    trace,
    'initial_challenge.www_authenticate_header_parse',
    () => parseAuthenticateHeader(wwwAuthenticateHeader),
    { phase: 'initial_challenge', kind: 'deserialization' }
  );
  const { accessToken, tokenType } = await tryTokenExchange(tokenEndpoint, ticket);
  config.cachedAccessToken = accessToken;
  config.cachedTokenType = tokenType;

  await applyAuthorizedRequest(accessToken, tokenType);
  const traceSummary = summarizeTrace(trace);

  return {
    iteration,
    phase,
    challenge_status: challengeStatus,
    token_status: tokenStatus,
    authorized_status: authorizedStatus,
    policy_post_latency_ms: policyResult.policyPostMs,
    initial_challenge_latency_ms: initialChallengeMs,
    token_exchange_latency_ms: tokenExchangeMs,
    authorized_request_latency_ms: authorizedMs,
    total_flow_latency_ms: nowMs() - runStartMs,
    note,
    trace_summary: traceSummary,
    trace,
  };
}

async function main() {
  const outputDir = env('OUTPUT_DIR', path.join(repoRoot, 'benchmark-results'));
  const outputPrefix = env('OUTPUT_PREFIX', 'uma-odrl-flow');
  const iterations = Number(env('ITERATIONS', '30'));
  const warmupIterations = Number(env('WARMUP_ITERATIONS', '5'));
  const interIterationDelayMs = Number(env('INTER_ITERATION_DELAY_MS', '150'));

  const config = {
    resourceUrl: env('PANDA_UMA_RESOURCE', 'http://localhost:3000/alice/derived/acc-x/'),
    resourceMethod: env('PANDA_UMA_RESOURCE_METHOD', 'GET'),
    requireUmaChallenge: env('PANDA_UMA_REQUIRE_UMA_CHALLENGE', 'true').toLowerCase() === 'true',
    tokenRequestMode: env('PANDA_UMA_TOKEN_REQUEST_MODE', 'uma').toLowerCase(),
    tokenRequestFilePath: env('PANDA_UMA_TOKEN_REQUEST_FILE', ''),
    claimToken: env('PANDA_UMA_CLAIM_TOKEN', 'http://localhost:3000/alice/profile/card#me'),
    claimTokenFormat: env('PANDA_UMA_CLAIM_TOKEN_FORMAT', 'urn:solidlab:uma:claims:formats:webid'),
    odrlProfile: env('PANDA_UMA_ODRL_PROFILE', 'https://w3id.org/oac#'),
    odrlAction: env('PANDA_UMA_ODRL_ACTION', 'https://w3id.org/oac#read'),
    odrlAssigner: env('PANDA_UMA_ODRL_ASSIGNER', ''),
    odrlAssignee: env('PANDA_UMA_ODRL_ASSIGNEE', ''),
    odrlDescription: env('PANDA_UMA_ODRL_DESCRIPTION', 'Benchmark ODRL request for UMA-protected access.'),
    includePolicyPost: env('PANDA_UMA_INCLUDE_POLICY_POST', 'false').toLowerCase() === 'true',
    autoHealLocalStack: env('PANDA_UMA_AUTO_HEAL_LOCAL_STACK', 'true').toLowerCase() === 'true',
    ownerWebId: env('PANDA_UMA_OWNER_WEBID', ''),
    ownerEmail: env('PANDA_UMA_OWNER_EMAIL', ''),
    ownerPassword: env('PANDA_UMA_OWNER_PASSWORD', 'abc123'),
    asIssuer: env('PANDA_UMA_AUTH_SERVER', 'http://localhost:4000/uma'),
    policyContainerUrl: env('PANDA_UMA_POLICY_CONTAINER', ''),
    policyContentType: env('PANDA_UMA_POLICY_CONTENT_TYPE', 'text/turtle'),
    policyAuthorizationHeader: env('PANDA_UMA_POLICY_AUTHORIZATION', ''),
    policyBody: '',
    traceTimings: ['1', 'true', 'yes', 'on'].includes(env('UMA_TRACE_TIMINGS', env('DEBUG_UMA_LATENCY', '0')).toLowerCase()),
    reuseAccessToken: ['1', 'true', 'yes', 'on'].includes(env('PANDA_UMA_REUSE_ACCESS_TOKEN', 'false').toLowerCase()),
    cachedAccessToken: null,
    cachedTokenType: null,
  };

  const policyBodyFile = env('PANDA_UMA_POLICY_FILE', '');
  if (config.includePolicyPost) {
    if (!config.policyContainerUrl) {
      throw new Error('PANDA_UMA_POLICY_CONTAINER is required when PANDA_UMA_INCLUDE_POLICY_POST=true');
    }
    if (!policyBodyFile) {
      throw new Error('PANDA_UMA_POLICY_FILE is required when PANDA_UMA_INCLUDE_POLICY_POST=true');
    }
    config.policyBody = fs.readFileSync(policyBodyFile, 'utf8');
  }

  if (config.tokenRequestFilePath && !fs.existsSync(config.tokenRequestFilePath)) {
    throw new Error(`Token request file not found: ${config.tokenRequestFilePath}`);
  }
  if (config.autoHealLocalStack && isLocalUmaDemoResource(config.resourceUrl)) {
    const umaRepo = resolveRepoPath({
      cliValue: null,
      envVarName: 'UMA_REPO',
      defaultPath: siblingDefaults.umaRepo,
    });
    ensureRepoExists(umaRepo, {
      label: 'user-managed-access',
      envVarName: 'UMA_REPO',
      cliFlagName: null,
    });
  }

  await runDerivedPreflight({ resourcePaths: ['alice/spo2/'] });
  runStrictPreflight(config);

  // Strict derived-resource preflight: verify the SPO2 stream returns 401+UMA ticket,
  // not 500, before any CSV is written.

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.promises.mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `${outputPrefix}-${runId}.csv`);
  const summaryPath = path.join(outputDir, `${outputPrefix}-${runId}.summary.json`);
  const tracePath = path.join(outputDir, `${outputPrefix}-${runId}.trace.ndjson`);
  const stepSummaryPath = path.join(outputDir, `${outputPrefix}-${runId}.steps.summary.json`);

  const rows = [];
  const totalIterations = warmupIterations + iterations;

  for (let index = 0; index < totalIterations; index += 1) {
    const phase = index < warmupIterations ? 'warmup' : 'measured';
    const row = await runIteration(config, index + 1, phase);
    rows.push(row);
    if (index < totalIterations - 1) {
      await new Promise((resolve) => setTimeout(resolve, interIterationDelayMs));
    }
  }

  const measured = rows.filter((row) => row.phase === 'measured');
  const totalValues = measured.map((row) => row.total_flow_latency_ms).sort((a, b) => a - b);
  const initialValues = measured.map((row) => row.initial_challenge_latency_ms).sort((a, b) => a - b);
  const tokenValues = measured.map((row) => row.token_exchange_latency_ms).sort((a, b) => a - b);
  const authorizedValues = measured.map((row) => row.authorized_request_latency_ms).sort((a, b) => a - b);
  const policyPostValues = measured.map((row) => row.policy_post_latency_ms).sort((a, b) => a - b);

  const summary = {
    run_id: runId,
    resource: config.resourceUrl,
    token_request_mode: config.tokenRequestMode,
    token_request_file: config.tokenRequestFilePath || null,
    include_policy_post: config.includePolicyPost,
    trace_timings_enabled: config.traceTimings,
    reuse_access_token_enabled: config.reuseAccessToken,
    policy_container: config.policyContainerUrl || null,
    warmup_iterations: warmupIterations,
    measured_iterations: iterations,
    avg_total_flow_latency_ms: mean(totalValues),
    p95_total_flow_latency_ms: percentile(totalValues, 95),
    avg_initial_challenge_latency_ms: mean(initialValues),
    p95_initial_challenge_latency_ms: percentile(initialValues, 95),
    avg_token_exchange_latency_ms: mean(tokenValues),
    p95_token_exchange_latency_ms: percentile(tokenValues, 95),
    avg_authorized_request_latency_ms: mean(authorizedValues),
    p95_authorized_request_latency_ms: percentile(authorizedValues, 95),
    avg_policy_post_latency_ms: mean(policyPostValues),
    p95_policy_post_latency_ms: percentile(policyPostValues, 95),
    csv_path: csvPath,
    trace_path: config.traceTimings ? tracePath : null,
    steps_summary_path: config.traceTimings ? stepSummaryPath : null,
  };

  if (config.traceTimings) {
    const stepSummary = aggregateStepStats(rows);
    const repeatedOperations = stepSummary
      .filter((step) => step.repeated_per_iteration_avg > 1)
      .map((step) => ({
        step: step.step,
        repeated_per_iteration_avg: step.repeated_per_iteration_avg,
        avg_ms: step.avg_ms,
      }));

    const measuredTraceSummaries = measured.map((row) => row.trace_summary).filter(Boolean);
    const avgTrackedTotals = {
      avg_network_ms: mean(measuredTraceSummaries.map((item) => item.network_ms)),
      avg_cpu_ms: mean(measuredTraceSummaries.map((item) => item.cpu_ms)),
      avg_serialization_ms: mean(measuredTraceSummaries.map((item) => item.serialization_ms)),
      avg_deserialization_ms: mean(measuredTraceSummaries.map((item) => item.deserialization_ms)),
      avg_crypto_ms: mean(measuredTraceSummaries.map((item) => item.crypto_ms)),
      avg_http_round_trips: mean(measuredTraceSummaries.map((item) => item.http_round_trips)),
    };

    summary.phase_breakdown = Object.fromEntries(
      Object.entries(avgTrackedTotals).map(([key, value]) => [key, Number(value.toFixed(3))])
    );
    summary.top_steps_by_avg_ms = stepSummary.slice(0, 20);
    summary.repeated_operations = repeatedOperations;

    const traceLines = rows.map((row) => JSON.stringify({
      iteration: row.iteration,
      phase: row.phase,
      note: row.note,
      metrics: {
        initial_challenge_latency_ms: row.initial_challenge_latency_ms,
        token_exchange_latency_ms: row.token_exchange_latency_ms,
        authorized_request_latency_ms: row.authorized_request_latency_ms,
        total_flow_latency_ms: row.total_flow_latency_ms,
      },
      trace_summary: row.trace_summary || null,
      http_calls: row.trace?.http || [],
      steps: row.trace?.steps || [],
    }));
    await fs.promises.writeFile(tracePath, `${traceLines.join('\n')}\n`);
    await fs.promises.writeFile(stepSummaryPath, `${JSON.stringify(stepSummary, null, 2)}\n`);
  }

  const csvHeader = [
    'iteration',
    'phase',
    'challenge_status',
    'token_status',
    'authorized_status',
    'policy_post_latency_ms',
    'initial_challenge_latency_ms',
    'token_exchange_latency_ms',
    'authorized_request_latency_ms',
    'total_flow_latency_ms',
    'note',
  ].join(',');

  const csvRows = rows.map((row) => [
    row.iteration,
    row.phase,
    row.challenge_status,
    row.token_status ?? '',
    row.authorized_status,
    row.policy_post_latency_ms,
    row.initial_challenge_latency_ms,
    row.token_exchange_latency_ms,
    row.authorized_request_latency_ms,
    row.total_flow_latency_ms,
    JSON.stringify(row.note),
  ].join(','));

  await fs.promises.writeFile(csvPath, `${csvHeader}\n${csvRows.join('\n')}\n`);
  await fs.promises.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`[benchmark:uma-odrl] FAILED: ${error.message}`);
  process.exitCode = 1;
});
