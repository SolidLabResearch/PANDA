#!/usr/bin/env node

/**
 * Diagnostic script: check-derived-registration
 *
 * Verifies that the expected UMA-protected derived resources produce a proper
 * 401 + WWW-Authenticate UMA challenge.  A 500 response indicates the
 * MemoryMapStorage umaIdStore was cleared by a CSS/UMA-AS restart and
 * script:setup-alice-derived must be re-run.
 *
 * Usage:
 *   node scripts/uma/check-derived-registration.js
 *
 * Override targets via environment variables:
 *   PANDA_CSS_BASE        default http://localhost:3000
 *   PANDA_UMA_AS_BASE     default http://localhost:4000/uma
 *   PANDA_AGGREGATOR_BASE default http://localhost:8080
 *   PANDA_CHECK_RESOURCES comma-separated resource paths under CSS_BASE
 *                         default alice/spo2/
 */

'use strict';

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseUmaHeader(header) {
  if (!header) return null;
  if (!/^UMA\s+/i.test(header)) return null;
  const params = Object.fromEntries(
    header.replace(/^UMA\s+/i, '').split(/\s*,\s*/).map((part) => {
      const idx = part.indexOf('=');
      if (idx < 0) return [part.trim(), ''];
      return [part.slice(0, idx).trim(), part.slice(idx + 1).trim().replace(/^"|"$/g, '')];
    })
  );
  return params.ticket && params.as_uri ? params : null;
}

const SETUP_HINT = [
  'To fix: restart both CSS and UMA-AS if they are not running, then run:',
  '  cd <workspace>/user-managed-access',
  '  corepack yarn run script:setup-alice-derived',
  'Alternatively, use the full stack restart helper:',
  '  cd <workspace>/PANDA',
  '  npm run uma:start:odrl:logged',
].join('\n');

async function checkResource(baseUrl, resourcePath) {
  const url = `${baseUrl}/${resourcePath}`;
  let status;
  let header;

  try {
    const response = await fetch(url);
    status = response.status;
    header = response.headers.get('WWW-Authenticate') || '';
  } catch (err) {
    return {
      path: resourcePath,
      url,
      status: null,
      verdict: 'error',
      detail: `Network error: ${err.message}`,
    };
  }

  const parsed = parseUmaHeader(header);

  if (status === 401 && parsed) {
    return {
      path: resourcePath,
      url,
      status,
      verdict: 'ok',
      detail: `401 + UMA ticket present (as_uri=${parsed.as_uri})`,
    };
  }

  if (status === 500) {
    return {
      path: resourcePath,
      url,
      status,
      verdict: 'stale',
      detail: [
        'HTTP 500: CSS could not build a UMA challenge for this resource.',
        'Root cause: MemoryMapStorage (umaIdStore) was cleared by a CSS/UMA-AS restart.',
        'The resource is not registered with the UMA AS in the current process.',
        SETUP_HINT,
      ].join('\n'),
    };
  }

  if (status === 401 && !parsed) {
    return {
      path: resourcePath,
      url,
      status,
      verdict: 'bad_challenge',
      detail: `401 but WWW-Authenticate header is missing or not a UMA challenge: "${header}"`,
    };
  }

  return {
    path: resourcePath,
    url,
    status,
    verdict: 'unexpected',
    detail: `Unexpected status ${status}. Expected 401 + UMA ticket.`,
  };
}

async function checkServices(cssBase, asBase) {
  const results = { css: false, as: false };

  try {
    const cssResponse = await fetch(cssBase);
    results.css = cssResponse.status < 600;
  } catch {
    results.css = false;
  }

  try {
    const asUrl = `${asBase}/.well-known/uma2-configuration`;
    const asResponse = await fetch(asUrl);
    results.as = asResponse.status === 200;
  } catch {
    results.as = false;
  }

  return results;
}

async function checkPanda(pandaBase) {
  try {
    const response = await fetch(pandaBase);
    return response.status < 600;
  } catch {
    return false;
  }
}

async function main() {
  const cssBase = env('PANDA_CSS_BASE', 'http://localhost:3000').replace(/\/$/, '');
  const asBase = env('PANDA_UMA_AS_BASE', 'http://localhost:4000/uma').replace(/\/$/, '');
  const pandaBase = env('PANDA_AGGREGATOR_BASE', 'http://localhost:8080').replace(/\/$/, '');
  const resourcesRaw = env(
    'PANDA_CHECK_RESOURCES',
    'alice/spo2/'
  );
  const resourcePaths = resourcesRaw.split(',').map((path) => path.trim()).filter(Boolean);

  console.log('[check-derived-registration] Starting...');
  console.log(`[check-derived-registration] CSS base: ${cssBase}`);
  console.log(`[check-derived-registration] UMA AS: ${asBase}`);
  console.log(`[check-derived-registration] PANDA: ${pandaBase}`);
  console.log(`[check-derived-registration] Resources: ${resourcePaths.join(', ')}`);
  console.log('');

  const services = await checkServices(cssBase, asBase);

  if (!services.css) {
    console.error(`[check-derived-registration] FAIL: CSS server at ${cssBase} is not reachable.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check-derived-registration] CSS reachable: yes`);

  if (!services.as) {
    console.error(`[check-derived-registration] FAIL: UMA AS at ${asBase} is not reachable.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check-derived-registration] UMA AS reachable: yes`);
  console.log('');

  const pandaReachable = await checkPanda(pandaBase);
  if (!pandaReachable) {
    console.error(`[check-derived-registration] FAIL: PANDA aggregator at ${pandaBase} is not reachable.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check-derived-registration] PANDA reachable: yes`);
  console.log('');

  const results = [];
  for (const resourcePath of resourcePaths) {
    const result = await checkResource(cssBase, resourcePath);
    results.push(result);

    const prefix = `[check-derived-registration] ${result.verdict.toUpperCase().padEnd(15)} ${result.path}`;
    if (result.verdict === 'ok') {
      console.log(`${prefix} -> ${result.detail}`);
    } else {
      console.error(`${prefix}`);
      for (const line of result.detail.split('\n')) {
        console.error(`  ${line}`);
      }
    }
  }

  console.log('');

  const failures = results.filter((result) => result.verdict !== 'ok');
  const staleCount = results.filter((result) => result.verdict === 'stale').length;

  if (staleCount > 0) {
    console.error(`[check-derived-registration] SUMMARY: ${staleCount} resource(s) returned HTTP 500 (stale UMA registration).`);
    console.error(`[check-derived-registration] ${SETUP_HINT}`);
    process.exitCode = 1;
    return;
  }

  if (failures.length > 0) {
    console.error(`[check-derived-registration] SUMMARY: ${failures.length} resource(s) failed preflight checks.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[check-derived-registration] SUMMARY: All ${results.length} resource(s) have valid UMA registrations.`);
}

main().catch((err) => {
  console.error(`[check-derived-registration] Unexpected error: ${err.message}`);
  process.exitCode = 1;
});
