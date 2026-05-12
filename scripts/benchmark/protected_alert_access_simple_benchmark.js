#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}
function nowMs() { return Number(process.hrtime.bigint()) / 1_000_000; }

function parseArgs(argv) {
  const out = {
    alertTarget: env('PANDA_ALERT_TARGET', 'http://localhost:3000/alice/derived/anomaly-alert/'),
    benchmarkRunId: env('BENCHMARK_RUN_ID', ''),
    benchmarkId: env('BENCHMARK_ID', ''),
    claimToken: env('PANDA_UMA_CLAIM_TOKEN', 'http://localhost:3000/bob/profile/card#me'),
    claimTokenFormat: env('PANDA_UMA_CLAIM_TOKEN_FORMAT', 'urn:solidlab:uma:claims:formats:webid'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--alert-target') out.alertTarget = argv[i + 1];
    if (argv[i] === '--benchmark-run-id') out.benchmarkRunId = argv[i + 1];
    if (argv[i] === '--benchmark-id') out.benchmarkId = argv[i + 1];
  }
  if (!out.benchmarkRunId) throw new Error('--benchmark-run-id is required');
  return out;
}

function parseUmaChallenge(header) {
  if (!header || !/^UMA\s+/i.test(header)) throw new Error(`Invalid UMA header: ${header || 'none'}`);
  const params = Object.fromEntries(header.replace(/^UMA\s+/i, '').split(/\s*,\s*/).map((p) => {
    const i = p.indexOf('=');
    if (i < 0) return [p.trim(), ''];
    return [p.slice(0, i).trim(), p.slice(i + 1).trim().replace(/^"|"$/g, '')];
  }));
  if (!params.ticket || !params.as_uri) throw new Error('UMA challenge missing ticket/as_uri');
  return { ticket: params.ticket, tokenEndpoint: new URL('token', params.as_uri.endsWith('/') ? params.as_uri : `${params.as_uri}/`).toString() };
}

function classifyFailure(ctx) {
  if (ctx.alertExists === false) return 'alert missing';
  if (ctx.alertHasRunId === false) return 'alert does not contain benchmark_run_id';
  if (ctx.notProtected === true) return 'alert not protected';
  if (ctx.challengeParseError === true) return 'UMA challenge parse failure';
  if (ctx.tokenError === true) return 'UMA token exchange failure';
  if (ctx.authorizedReadError === true) return 'authorized alert read failure';
  if (ctx.responseMismatch === true) return 'protected alert response mismatch';
  if (ctx.serviceFailure === true) return 'environment/service failure';
  return 'other';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.benchmarkId || new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(ROOT, 'benchmark-results', `protected-alert-access-simple-${runId}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, `protected-alert-access-simple-${runId}.summary.json`);

  const s = {
    benchmark_name: 'protected-alert-access-simple',
    run_id: runId,
    status: 'failed',
    alert_target_url: args.alertTarget,
    expected_benchmark_run_id: args.benchmarkRunId,
    unauthenticated_alert_get_status: null,
    alert_challenge_status: null,
    alert_token_exchange_status: null,
    authorized_alert_get_status: null,
    alert_challenge_latency_ms: null,
    alert_token_exchange_latency_ms: null,
    authorized_alert_get_latency_ms: null,
    protected_alert_access_total_latency_ms: null,
    authorized_response_contains_expected_benchmark_run_id: false,
    failure_class: null,
    failure_reason: null,
  };
  const ctx = {};

  try {
    const seed = await fetch(args.alertTarget, { method: 'GET', headers: { Accept: 'text/turtle' } });
    const seedBody = await seed.text().catch(() => '');
    ctx.alertExists = seed.status !== 404;
    ctx.alertHasRunId = seedBody.includes(args.benchmarkRunId);
    if (!ctx.alertExists) throw new Error(`alert target missing: ${args.alertTarget}`);
    if (!ctx.alertHasRunId) throw new Error('alert does not include expected benchmark_run_id');

    const t0 = nowMs();
    const c0 = nowMs();
    const challengeRes = await fetch(args.alertTarget, { method: 'GET' });
    s.alert_challenge_latency_ms = nowMs() - c0;
    s.unauthenticated_alert_get_status = challengeRes.status;
    s.alert_challenge_status = challengeRes.status;
    if (challengeRes.status === 200) { ctx.notProtected = true; throw new Error('unauthenticated GET returned 200'); }

    let challenge;
    try { challenge = parseUmaChallenge(challengeRes.headers.get('WWW-Authenticate') || ''); }
    catch (e) { ctx.challengeParseError = true; throw e; }

    const x0 = nowMs();
    const tokenRes = await fetch(challenge.tokenEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
        ticket: challenge.ticket,
        claim_token: encodeURIComponent(args.claimToken),
        claim_token_format: args.claimTokenFormat,
      }),
    });
    const tokenText = await tokenRes.text();
    s.alert_token_exchange_latency_ms = nowMs() - x0;
    s.alert_token_exchange_status = tokenRes.status;
    if (tokenRes.status !== 200) { ctx.tokenError = true; throw new Error(`token exchange failed (${tokenRes.status}): ${tokenText.slice(0, 300)}`); }
    const tokenJson = JSON.parse(tokenText);
    if (!tokenJson.access_token) { ctx.tokenError = true; throw new Error('token exchange missing access_token'); }

    const a0 = nowMs();
    const authRes = await fetch(args.alertTarget, { method: 'GET', headers: { Authorization: `${tokenJson.token_type || 'Bearer'} ${tokenJson.access_token}` } });
    const authBody = await authRes.text().catch(() => '');
    s.authorized_alert_get_latency_ms = nowMs() - a0;
    s.authorized_alert_get_status = authRes.status;
    s.protected_alert_access_total_latency_ms = nowMs() - t0;
    if (authRes.status !== 200) { ctx.authorizedReadError = true; throw new Error(`authorized GET failed (${authRes.status})`); }

    s.authorized_response_contains_expected_benchmark_run_id = authBody.includes(args.benchmarkRunId);
    if (!s.authorized_response_contains_expected_benchmark_run_id) { ctx.responseMismatch = true; throw new Error('authorized response missing expected benchmark_run_id'); }

    s.status = 'ok';
  } catch (error) {
    if (/econnrefused|fetch failed|network|timed out/i.test(String(error.message || ''))) ctx.serviceFailure = true;
    s.failure_class = classifyFailure(ctx);
    s.failure_reason = error.message;
  }

  fs.writeFileSync(summaryPath, `${JSON.stringify(s, null, 2)}\n`);
  console.log(JSON.stringify(s, null, 2));
  process.exit(s.status === 'ok' ? 0 : 1);
}

main();
