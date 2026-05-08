#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runDerivedPreflight } = require('../uma/preflight-derived');
const { repoRoot } = require('./workspace_paths');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function boolEnv(name, fallback = false) {
  return ['1', 'true', 'yes', 'on'].includes(env(name, String(fallback)).toLowerCase());
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function parseAuthenticateHeader(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) throw new Error('Missing WWW-Authenticate header');
  if (!/^UMA\s+/i.test(wwwAuthenticateHeader)) throw new Error(`Expected UMA challenge, got: ${wwwAuthenticateHeader}`);

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

  if (!params.ticket) throw new Error(`UMA challenge missing ticket: ${wwwAuthenticateHeader}`);
  if (!params.as_uri) throw new Error(`UMA challenge missing as_uri: ${wwwAuthenticateHeader}`);

  const tokenEndpoint = new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString();
  return { tokenEndpoint, ticket: params.ticket };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function strictOdrlLogSetupHint() {
  return [
    'To produce a valid live ODRL proof log, run:',
    `  cd "${repoRoot}"`,
    '  npm run uma:start:odrl:logged',
    '  export PANDA_UMA_ODRL_LOG_FILE="<path printed by helper>"',
  ].join('\n');
}

function extractLogProof(logChunk, resource, allowClaim, denyClaim) {
  const containsAuthorizer = /OdrlAuthorizer/.test(logChunk);
  const allowPattern = new RegExp(`Evaluating Request \\[S R AR\\]: \\[${escapeRegExp(allowClaim)} ${escapeRegExp(resource)} `);
  const denyPattern = new RegExp(`Evaluating Request \\[S R AR\\]: \\[${escapeRegExp(denyClaim)} ${escapeRegExp(resource)} `);
  return {
    containsAuthorizer,
    allowEvaluated: allowPattern.test(logChunk),
    denyEvaluated: denyPattern.test(logChunk),
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getChallenge(resource) {
  const started = nowMs();
  const response = await fetch(resource, { method: 'GET' });
  const ended = nowMs();
  const wwwAuthenticate = response.headers.get('WWW-Authenticate') || '';
  let parsed = null;
  try {
    parsed = parseAuthenticateHeader(wwwAuthenticate);
  } catch {
    parsed = null;
  }
  return {
    latencyMs: ended - started,
    status: response.status,
    wwwAuthenticate,
    parsed,
  };
}

async function exchangeToken(tokenEndpoint, ticket, claimToken, claimTokenFormat, tokenRequestMode, requestTemplatePath) {
  let body;
  if (tokenRequestMode === 'odrl') {
    if (requestTemplatePath) {
      const fromFile = JSON.parse(fs.readFileSync(requestTemplatePath, 'utf8'));
      body = {
        ...fromFile,
        grant_type: fromFile.grant_type || 'urn:ietf:params:oauth:grant-type:uma-ticket',
        ticket,
      };
    } else {
      body = {
        '@context': 'http://www.w3.org/ns/odrl.jsonld',
        '@type': 'Request',
        uid: `urn:uuid:${crypto.randomUUID()}`,
        permission: [{
          '@type': 'Permission',
          target: env('PANDA_UMA_RESOURCE', 'http://localhost:3000/alice/spo2/'),
          action: { '@id': 'https://w3id.org/oac#read' },
          assigner: env('PANDA_UMA_POLICY_OWNER_WEBID', 'http://localhost:3000/alice/profile/card#me'),
          assignee: decodeURIComponent(claimToken),
        }],
        grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
        ticket,
        claim_token: claimToken,
        claim_token_format: claimTokenFormat,
      };
    }
  } else {
    body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: encodeURIComponent(claimToken),
      claim_token_format: claimTokenFormat,
    };
  }

  const started = nowMs();
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const ended = nowMs();

  let json = null;
  try { json = JSON.parse(raw); } catch { json = null; }

  return {
    latencyMs: ended - started,
    status: response.status,
    raw,
    json,
  };
}

async function fetchWithToken(resource, tokenType, accessToken) {
  const started = nowMs();
  const response = await fetch(resource, {
    method: 'GET',
    headers: { Authorization: `${tokenType} ${accessToken}` },
  });
  const body = await response.text();
  const ended = nowMs();
  return {
    latencyMs: ended - started,
    status: response.status,
    body,
  };
}

async function postPolicy(policyEndpoint, ownerWebId, turtle) {
  const response = await fetch(policyEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      Authorization: `WebID ${encodeURIComponent(ownerWebId)}`,
    },
    body: turtle,
  });
  if (!(response.status === 201 || response.status === 409)) {
    const body = await response.text().catch(() => '');
    throw new Error(`Policy POST failed (${response.status}): ${body}`);
  }
}

function scenarioPolicies(config) {
  const base = `PREFIX odrl: <http://www.w3.org/ns/odrl/2/>\nPREFIX ex: <http://example.org/>\n`;
  return {
    simple_allow: `${base}ex:p1 a odrl:Agreement ; odrl:uid ex:p1 ; odrl:permission ex:perm1 .\nex:perm1 a odrl:Permission ; odrl:target <${config.resource}> ; odrl:assigner <${config.ownerWebId}> ; odrl:assignee <${config.allowClaim}> ; odrl:action odrl:read .`,
    moderate_purpose_allow: `${base}ex:p2 a odrl:Agreement ; odrl:uid ex:p2 ; odrl:permission ex:perm2 .\nex:perm2 a odrl:Permission ; odrl:target <${config.resource}> ; odrl:assigner <${config.ownerWebId}> ; odrl:assignee <${config.allowClaim}> ; odrl:action odrl:read ; odrl:constraint [ a odrl:Constraint ; odrl:leftOperand odrl:purpose ; odrl:operator odrl:eq ; odrl:rightOperand <urn:client:benchmark-purpose> ] .`,
    complex_constraints_derived_allow: `${base}ex:p3 a odrl:Agreement ; odrl:uid ex:p3 ; odrl:permission ex:perm3 .\nex:perm3 a odrl:Permission ; odrl:target <${config.derivedResource}> ; odrl:assigner <${config.ownerWebId}> ; odrl:assignee <${config.allowClaim}> ; odrl:action odrl:read ; odrl:constraint [ a odrl:Constraint ; odrl:leftOperand odrl:purpose ; odrl:operator odrl:eq ; odrl:rightOperand <urn:client:benchmark-complex> ] .`,
  };
}

async function runScenarioIteration(config, scenario, mode, iteration, cache) {
  const row = {
    scenario: scenario.id,
    mode,
    iteration,
    started_at: new Date().toISOString(),
    challenge_status: null,
    token_status: null,
    final_status: null,
    initial_challenge_latency_ms: 0,
    permission_ticket_issuance_latency_ms: 0,
    token_exchange_latency_ms: 0,
    final_authorized_request_latency_ms: 0,
    denial_latency_ms: 0,
    total_flow_latency_ms: 0,
    valid: false,
    invalid_reason: '',
  };

  const totalStart = nowMs();
  try {
    const challenge = await getChallenge(scenario.resource);
    row.challenge_status = challenge.status;
    row.initial_challenge_latency_ms = challenge.latencyMs;
    row.permission_ticket_issuance_latency_ms = challenge.latencyMs;

    if (challenge.status !== 401 || !challenge.parsed) {
      throw new Error(`Expected 401 UMA challenge with ticket, got status=${challenge.status}`);
    }

    let tokenInfo = null;
    const canReuse = mode === 'warm' && scenario.allow && cache.accessToken && cache.tokenType;
    if (canReuse) {
      tokenInfo = { access_token: cache.accessToken, token_type: cache.tokenType, reused: true };
    } else {
      const exchange = await exchangeToken(
        challenge.parsed.tokenEndpoint,
        challenge.parsed.ticket,
        scenario.claimToken,
        config.claimTokenFormat,
        scenario.tokenRequestMode,
        scenario.tokenRequestFile
      );
      row.token_status = exchange.status;
      row.token_exchange_latency_ms = exchange.latencyMs;

      if (scenario.expectDeny) {
        row.denial_latency_ms = exchange.latencyMs;
        if (exchange.status === 200) {
          throw new Error('Denial scenario unexpectedly returned 200 during token exchange');
        }
        if (exchange.status !== 403) {
          throw new Error(`Denial scenario expected 403 token exchange, got ${exchange.status}`);
        }
      } else {
        if (exchange.status !== 200) {
          throw new Error(`Allow scenario expected 200 token exchange, got ${exchange.status}: ${exchange.raw}`);
        }
        const accessToken = exchange.json?.access_token;
        const tokenType = exchange.json?.token_type || 'Bearer';
        if (!accessToken) throw new Error('Allow scenario token exchange missing access_token');
        tokenInfo = { access_token: accessToken, token_type: tokenType, reused: false };
        if (mode === 'warm') {
          cache.accessToken = accessToken;
          cache.tokenType = tokenType;
        }
      }
    }

    if (!scenario.expectDeny) {
      const authorized = await fetchWithToken(scenario.resource, tokenInfo.token_type, tokenInfo.access_token);
      row.final_status = authorized.status;
      row.final_authorized_request_latency_ms = authorized.latencyMs;
      if (authorized.status !== 200) {
        throw new Error(`Allow scenario expected final authorized 200, got ${authorized.status}`);
      }
    } else {
      row.final_status = row.token_status;
    }

    row.total_flow_latency_ms = nowMs() - totalStart;
    row.valid = true;
  } catch (error) {
    row.total_flow_latency_ms = nowMs() - totalStart;
    row.valid = false;
    row.invalid_reason = error.message;
  }
  return row;
}

function summarize(rows) {
  const byScenario = {};
  for (const row of rows) {
    byScenario[row.scenario] = byScenario[row.scenario] || [];
    byScenario[row.scenario].push(row);
  }

  const summary = {};
  for (const [scenario, scenarioRows] of Object.entries(byScenario)) {
    const validRows = scenarioRows.filter((row) => row.valid);
    const metrics = [
      'total_flow_latency_ms',
      'initial_challenge_latency_ms',
      'permission_ticket_issuance_latency_ms',
      'token_exchange_latency_ms',
      'final_authorized_request_latency_ms',
      'denial_latency_ms',
    ];
    summary[scenario] = {
      total_runs: scenarioRows.length,
      valid_runs: validRows.length,
      invalid_runs: scenarioRows.length - validRows.length,
      metrics: Object.fromEntries(metrics.map((metric) => {
        const values = validRows.map((row) => row[metric]).filter((value) => Number.isFinite(value) && value > 0);
        return [metric, {
          avg_ms: values.length ? Number(mean(values).toFixed(3)) : null,
          p95_ms: values.length ? Number(percentile(values, 95).toFixed(3)) : null,
        }];
      })),
    };
  }

  return summary;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

function findAnomalies(rows) {
  const anomalies = [];
  const byScenario = new Map();
  for (const row of rows.filter((row) => row.valid)) {
    const key = `${row.mode}|${row.scenario}`;
    if (!byScenario.has(key)) byScenario.set(key, []);
    byScenario.get(key).push(row.total_flow_latency_ms);
  }

  for (const row of rows.filter((row) => row.valid)) {
    const key = `${row.mode}|${row.scenario}`;
    const values = byScenario.get(key) || [];
    if (values.length < 5) continue;
    const p50 = percentile(values, 50);
    if (row.total_flow_latency_ms < p50 * 0.25) {
      anomalies.push({
        scenario: row.scenario,
        mode: row.mode,
        iteration: row.iteration,
        reason: `Unusually fast run: ${row.total_flow_latency_ms.toFixed(3)}ms vs median ${p50.toFixed(3)}ms`,
      });
    }
  }

  for (const row of rows.filter((row) => !row.valid)) {
    anomalies.push({
      scenario: row.scenario,
      mode: row.mode,
      iteration: row.iteration,
      reason: `Invalid run: ${row.invalid_reason}`,
    });
  }

  return anomalies;
}

async function replayerProtectedCheck(config) {
  const endpoint = config.replayerProtectedResource;
  if (!endpoint) {
    return { skipped: true, reason: 'PANDA_REPLAYER_PROTECTED_RESOURCE not set' };
  }

  const response = await fetch(endpoint, { method: 'GET' });
  if (response.status === 200) {
    throw new Error(`REPLAYER scenario failed: tokenless protected request returned 200 at ${endpoint}`);
  }

  return {
    skipped: false,
    status: response.status,
    protected_endpoint: endpoint,
  };
}

async function runStrictPreflight(config) {
  const logFile = config.odrlLogFile;
  if (!logFile) {
    throw new Error(
      [
        'Preflight failed: PANDA_UMA_ODRL_LOG_FILE is not set.',
        'Expected ODRL marker pattern: /OdrlAuthorizer/.',
        strictOdrlLogSetupHint(),
      ].join('\n')
    );
  }
  if (!fs.existsSync(logFile)) {
    throw new Error(
      [
        `Preflight failed: ODRL log file not found: ${logFile}`,
        'Expected ODRL marker pattern: /OdrlAuthorizer/.',
        strictOdrlLogSetupHint(),
      ].join('\n')
    );
  }

  const before = safeRead(logFile);
  if (!before) {
    throw new Error(
      [
        `Preflight failed: ODRL log file is empty or unreadable: ${logFile}`,
        'Expected ODRL marker pattern: /OdrlAuthorizer/.',
        strictOdrlLogSetupHint(),
      ].join('\n')
    );
  }

  const c1 = await getChallenge(config.resource);
  assert(c1.status === 401, `Preflight failed: expected 401 challenge, got ${c1.status}`);
  assert(c1.parsed, 'Preflight failed: missing UMA challenge ticket/as_uri');

  const allowExchange = await exchangeToken(c1.parsed.tokenEndpoint, c1.parsed.ticket, config.allowClaim, config.claimTokenFormat, 'uma', '');
  assert(allowExchange.status === 200, `Preflight failed: allow token exchange expected 200, got ${allowExchange.status}`);
  const accessToken = allowExchange.json?.access_token;
  const tokenType = allowExchange.json?.token_type || 'Bearer';
  assert(accessToken, 'Preflight failed: allow token exchange missing access_token');

  const allowFetch = await fetchWithToken(config.resource, tokenType, accessToken);
  assert(allowFetch.status === 200, `Preflight failed: allow authorized request expected 200, got ${allowFetch.status}`);

  const wrongTargetFetch = await fetchWithToken(config.wrongTargetResource, tokenType, accessToken);
  assert(
    wrongTargetFetch.status === 401 || wrongTargetFetch.status === 403,
    `Preflight failed: wrong-target expected 401/403, got ${wrongTargetFetch.status}`
  );

  const c2 = await getChallenge(config.resource);
  assert(c2.status === 401 && c2.parsed, `Preflight failed: deny path challenge expected 401+ticket, got ${c2.status}`);
  const denyExchange = await exchangeToken(c2.parsed.tokenEndpoint, c2.parsed.ticket, config.denyClaim, config.claimTokenFormat, 'uma', '');
  assert(denyExchange.status === 403, `Preflight failed: deny token exchange expected 403, got ${denyExchange.status}`);

  const after = safeRead(logFile);
  const delta = after.slice(before.length);
  const proof = extractLogProof(delta, config.resource, config.allowClaim, config.denyClaim);

  assert(
    proof.containsAuthorizer,
    [
      'Preflight failed: OdrlAuthorizer log marker missing.',
      'Expected ODRL marker pattern: /OdrlAuthorizer/.',
      `Checked log file: ${logFile}`,
      strictOdrlLogSetupHint(),
    ].join('\n')
  );
  assert(
    proof.allowEvaluated,
    [
      `Preflight failed: OdrlAuthorizer allow evaluation log missing for ${config.allowClaim}.`,
      `Expected allow evaluation pattern: Evaluating Request [S R AR]: [${config.allowClaim} ${config.resource} ...]`,
      `Checked log file: ${logFile}`,
      strictOdrlLogSetupHint(),
    ].join('\n')
  );
  assert(
    proof.denyEvaluated,
    [
      `Preflight failed: OdrlAuthorizer deny evaluation log missing for ${config.denyClaim}.`,
      `Expected deny evaluation pattern: Evaluating Request [S R AR]: [${config.denyClaim} ${config.resource} ...]`,
      `Checked log file: ${logFile}`,
      strictOdrlLogSetupHint(),
    ].join('\n')
  );

  return {
    challenge_status: c1.status,
    allow_exchange_status: allowExchange.status,
    allow_fetch_status: allowFetch.status,
    wrong_target_status: wrongTargetFetch.status,
    deny_exchange_status: denyExchange.status,
    odrl_log_proof: proof,
  };
}

async function main() {
  // Strict derived-resource preflight before any output directory is created.
  // Fails immediately with an actionable message if any resource returns 500
  // (indicating stale UMA registration from a CSS/UMA-AS restart).
  await runDerivedPreflight({ resourcePaths: ['alice/spo2/'] });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(repoRoot, 'benchmark-results', timestamp);
  fs.mkdirSync(outputDir, { recursive: true });

  const config = {
    resource: env('PANDA_UMA_RESOURCE', 'http://localhost:3000/alice/spo2/'),
    derivedResource: env('PANDA_UMA_DERIVED_RESOURCE', env('PANDA_UMA_RESOURCE', 'http://localhost:3000/alice/spo2/')),
    wrongTargetResource: env('PANDA_UMA_WRONG_TARGET_RESOURCE', 'http://localhost:3000/alice/'),
    allowClaim: env('PANDA_UMA_CLAIM_TOKEN', 'http://localhost:3000/bob/profile/card#me'),
    denyClaim: env('PANDA_UMA_DENY_CLAIM_TOKEN', 'http://localhost:3000/demo/profile/card#me'),
    claimTokenFormat: env('PANDA_UMA_CLAIM_TOKEN_FORMAT', 'urn:solidlab:uma:claims:formats:webid'),
    policyEndpoint: env('PANDA_UMA_POLICY_ENDPOINT', 'http://localhost:4000/uma/policies'),
    ownerWebId: env('PANDA_UMA_POLICY_OWNER_WEBID', 'http://localhost:3000/alice/profile/card#me'),
    odrlLogFile: env('PANDA_UMA_ODRL_LOG_FILE', ''),
    replayerProtectedResource: env('PANDA_REPLAYER_PROTECTED_RESOURCE', ''),
    iterations: Number(env('ITERATIONS', '20')),
    coldIterations: Number(env('COLD_ITERATIONS', env('ITERATIONS', '20'))),
    warmIterations: Number(env('WARM_ITERATIONS', env('ITERATIONS', '20'))),
    interIterationDelayMs: Number(env('INTER_ITERATION_DELAY_MS', '100')),
    enableConstraintViolationScenario: boolEnv('PANDA_UMA_ENABLE_CONSTRAINT_VIOLATION', false),
  };

  if (config.iterations < 1 || config.coldIterations < 1 || config.warmIterations < 1) {
    throw new Error('Iterations must be >= 1');
  }

  const preflight = await runStrictPreflight(config);

  const policies = scenarioPolicies(config);
  await postPolicy(config.policyEndpoint, config.ownerWebId, policies.simple_allow);
  await postPolicy(config.policyEndpoint, config.ownerWebId, policies.moderate_purpose_allow);
  await postPolicy(config.policyEndpoint, config.ownerWebId, policies.complex_constraints_derived_allow);

  const scenarios = [
    {
      id: 'allow_simple_policy',
      allow: true,
      expectDeny: false,
      resource: config.resource,
      claimToken: config.allowClaim,
      tokenRequestMode: 'uma',
      tokenRequestFile: '',
    },
    {
      id: 'allow_moderate_constrained_policy',
      allow: true,
      expectDeny: false,
      resource: config.resource,
      claimToken: config.allowClaim,
      tokenRequestMode: 'odrl',
      tokenRequestFile: '',
    },
    {
      id: 'allow_complex_constrained_policy',
      allow: true,
      expectDeny: false,
      resource: config.derivedResource,
      claimToken: config.allowClaim,
      tokenRequestMode: 'odrl',
      tokenRequestFile: '',
    },
    {
      id: 'deny_unauthorized_requester',
      allow: false,
      expectDeny: true,
      resource: config.resource,
      claimToken: config.denyClaim,
      tokenRequestMode: 'uma',
      tokenRequestFile: '',
    },
    {
      id: 'derived_resource_allow',
      allow: true,
      expectDeny: false,
      resource: config.derivedResource,
      claimToken: config.allowClaim,
      tokenRequestMode: 'uma',
      tokenRequestFile: '',
    },
  ];

  if (config.enableConstraintViolationScenario) {
    scenarios.push({
      id: 'deny_constraint_violation',
      allow: false,
      expectDeny: true,
      resource: config.resource,
      claimToken: config.allowClaim,
      tokenRequestMode: 'odrl',
      tokenRequestFile: env('PANDA_UMA_CONSTRAINT_VIOLATION_ODRL_REQUEST_FILE', ''),
    });
  }

  const rows = [];
  for (const mode of ['cold', 'warm']) {
    for (const scenario of scenarios) {
      const total = mode === 'cold' ? config.coldIterations : config.warmIterations;
      const cache = { accessToken: null, tokenType: null };
      for (let i = 0; i < total; i += 1) {
        const row = await runScenarioIteration(config, scenario, mode, i + 1, cache);
        rows.push(row);
        if (i < total - 1) {
          await new Promise((resolve) => setTimeout(resolve, config.interIterationDelayMs));
        }
      }
    }
  }

  const replayerCheck = await replayerProtectedCheck(config);

  for (const row of rows) {
    if (row.challenge_status !== 401) {
      row.valid = false;
      row.invalid_reason = row.invalid_reason || `Run did not start with UMA 401 challenge (got ${row.challenge_status})`;
    }
    if (!row.token_status && row.final_status === 200) {
      row.valid = false;
      row.invalid_reason = row.invalid_reason || 'Run succeeded without token exchange';
    }
    if (row.scenario.startsWith('deny_') && row.final_status === 200) {
      row.valid = false;
      row.invalid_reason = row.invalid_reason || 'Denial case returned 200';
    }
  }

  const summaryByScenario = summarize(rows);
  const anomalies = findAnomalies(rows);

  const csvPath = path.join(outputDir, 'runs.csv');
  const summaryPath = path.join(outputDir, 'summary.json');

  const csvHeader = [
    'scenario',
    'mode',
    'iteration',
    'started_at',
    'challenge_status',
    'token_status',
    'final_status',
    'initial_challenge_latency_ms',
    'permission_ticket_issuance_latency_ms',
    'token_exchange_latency_ms',
    'final_authorized_request_latency_ms',
    'denial_latency_ms',
    'total_flow_latency_ms',
    'valid',
    'invalid_reason',
  ];

  const csvLines = [csvHeader.join(',')];
  for (const row of rows) {
    csvLines.push([
      row.scenario,
      row.mode,
      row.iteration,
      row.started_at,
      row.challenge_status,
      row.token_status,
      row.final_status,
      Number(row.initial_challenge_latency_ms.toFixed(3)),
      Number(row.permission_ticket_issuance_latency_ms.toFixed(3)),
      Number(row.token_exchange_latency_ms.toFixed(3)),
      Number(row.final_authorized_request_latency_ms.toFixed(3)),
      Number(row.denial_latency_ms.toFixed(3)),
      Number(row.total_flow_latency_ms.toFixed(3)),
      row.valid,
      row.invalid_reason,
    ].map(csvEscape).join(','));
  }

  fs.writeFileSync(csvPath, `${csvLines.join('\n')}\n`);

  const summary = {
    generated_at: new Date().toISOString(),
    output_dir: outputDir,
    preflight,
    scenarios_executed: scenarios.map((scenario) => scenario.id),
    valid_runs: rows.filter((row) => row.valid).length,
    invalid_runs: rows.filter((row) => !row.valid).length,
    per_scenario: summaryByScenario,
    anomalies,
    replayer_check: replayerCheck,
    csv_path: csvPath,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ output_dir: outputDir, csv_path: csvPath, summary_path: summaryPath }, null, 2));
}

main().catch((error) => {
  console.error(`[strict-benchmark] FAILED: ${error.message}`);
  process.exitCode = 1;
});
