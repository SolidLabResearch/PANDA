#!/usr/bin/env node

/**
 * preflight-derived
 *
 * Strict preflight check for UMA-protected derived resources.
 * Intended to be called at the start of every UMA/PANDA benchmark run.
 *
 * Checks:
 *   1. CSS server reachable
 *   2. UMA AS reachable and returning valid discovery document
 *   3. PANDA aggregator reachable
 *   4. Each configured protected resource returns 401 + UMA ticket (not 500)
 *
 * Fails immediately with an actionable message if any check fails.
 *
 * Can be used as a module:
 *   const { runDerivedPreflight } = require('./preflight-derived');
 *   await runDerivedPreflight();
 *
 * Or run standalone:
 *   node scripts/uma/preflight-derived.js
 *
 * Environment variables:
 *   PANDA_CSS_BASE           CSS server base URL (default http://localhost:3000)
 *   PANDA_UMA_AS_BASE        UMA AS base URL (default http://localhost:4000/uma)
 *   PANDA_AGGREGATOR_BASE    PANDA aggregator base URL (default http://localhost:8080)
 *   PANDA_PREFLIGHT_RESOURCES Comma-separated paths to check (default alice/spo2/)
 *   PANDA_SKIP_AGGREGATOR_CHECK Set to 1 to skip PANDA aggregator check
 */

'use strict';

const SETUP_HINT = [
  'ACTION REQUIRED:',
  '  1. Verify CSS (:3000) and UMA AS (:4000) are both running.',
  '  2. Re-run the derived resource setup:',
  '       cd <workspace>/user-managed-access',
  '       corepack yarn run script:setup-alice-derived',
  '  3. Alternatively use the full stack restart helper:',
  '       cd <workspace>/PANDA',
  '       npm run uma:start:odrl:logged',
  '  4. Then retry the benchmark.',
].join('\n');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseUmaChallenge(header) {
  if (!header || !/^UMA\s+/i.test(header)) return null;
  const params = Object.fromEntries(
    header.replace(/^UMA\s+/i, '').split(/\s*,\s*/).map((part) => {
      const idx = part.indexOf('=');
      if (idx < 0) return [part.trim(), ''];
      return [part.slice(0, idx).trim(), part.slice(idx + 1).trim().replace(/^"|"$/g, '')];
    })
  );
  return params.ticket && params.as_uri ? params : null;
}

async function checkCss(cssBase) {
  const label = 'CSS reachability';
  try {
    const response = await fetch(cssBase);
    if (response.status >= 600) throw new Error(`Non-HTTP status ${response.status}`);
    return { label, ok: true, detail: `status ${response.status}` };
  } catch (err) {
    return {
      label,
      ok: false,
      detail: `CSS server at ${cssBase} is not reachable: ${err.message}`,
      fatal: true,
    };
  }
}

async function checkUmaAs(asBase) {
  const label = 'UMA AS reachability';
  const url = `${asBase}/.well-known/uma2-configuration`;
  try {
    const response = await fetch(url);
    if (response.status !== 200) {
      return {
        label,
        ok: false,
        detail: `UMA AS discovery at ${url} returned ${response.status}. Expected 200.`,
        fatal: true,
      };
    }
    const body = await response.json().catch(() => null);
    if (!body || !body.token_endpoint) {
      return {
        label,
        ok: false,
        detail: `UMA AS discovery at ${url} returned invalid metadata (missing token_endpoint).`,
        fatal: true,
      };
    }
    return { label, ok: true, detail: `token_endpoint=${body.token_endpoint}` };
  } catch (err) {
    return {
      label,
      ok: false,
      detail: `UMA AS at ${asBase} is not reachable: ${err.message}`,
      fatal: true,
    };
  }
}

async function checkPanda(pandaBase) {
  const label = 'PANDA aggregator reachability';
  try {
    const response = await fetch(pandaBase);
    if (response.status >= 500) {
      return {
        label,
        ok: false,
        detail: `PANDA aggregator at ${pandaBase} returned ${response.status}.`,
        fatal: false,
      };
    }
    return { label, ok: true, detail: `status ${response.status}` };
  } catch (err) {
    return {
      label,
      ok: false,
      detail: `PANDA aggregator at ${pandaBase} is not reachable: ${err.message}`,
      fatal: false,
    };
  }
}

async function checkProtectedResource(cssBase, resourcePath) {
  const url = `${cssBase}/${resourcePath}`;
  const label = `UMA challenge for ${resourcePath}`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    return {
      label,
      path: resourcePath,
      ok: false,
      fatal: true,
      detail: `Network error fetching ${url}: ${err.message}`,
    };
  }

  const wwwAuth = response.headers.get('WWW-Authenticate') || '';
  const parsed = parseUmaChallenge(wwwAuth);

  if (response.status === 401 && parsed) {
    return {
      label,
      path: resourcePath,
      ok: true,
      detail: `401 + UMA ticket present (as_uri=${parsed.as_uri})`,
    };
  }

  if (response.status === 500) {
    const body = await response.text().catch(() => '');
    const isUmaHeaderError = /Error while requesting UMA header/i.test(body);
    return {
      label,
      path: resourcePath,
      ok: false,
      fatal: true,
      isStaleRegistration: isUmaHeaderError,
      detail: [
        `HTTP 500 on ${url}.`,
        isUmaHeaderError
          ? 'CSS could not build a UMA challenge: "Error while requesting UMA header". This is the stale-registration failure mode.'
          : `Body: ${body.slice(0, 200)}`,
        'The MemoryMapStorage (umaIdStore) was cleared when CSS/UMA-AS was restarted.',
        'Derived-resource registration is missing in the current UMA process.',
        'No benchmark result should be written until this is resolved.',
        SETUP_HINT,
      ].join('\n'),
    };
  }

  if (response.status === 401 && !parsed) {
    return {
      label,
      path: resourcePath,
      ok: false,
      fatal: true,
      detail: `401 at ${url} but WWW-Authenticate is not a valid UMA challenge: "${wwwAuth}"`,
    };
  }

  return {
    label,
    path: resourcePath,
    ok: false,
    fatal: true,
    detail: `Unexpected status ${response.status} at ${url}. Expected 401 + UMA ticket.`,
  };
}

/**
 * Run all preflight checks. Throws on any failure.
 *
 * @param {object} [opts]
 * @param {string} [opts.cssBase]
 * @param {string} [opts.asBase]
 * @param {string} [opts.pandaBase]
 * @param {string[]} [opts.resourcePaths]
 * @param {boolean} [opts.skipPandaCheck]
 * @returns {Promise<object>} preflight result summary
 */
async function runDerivedPreflight(opts = {}) {
  const cssBase = (opts.cssBase || env('PANDA_CSS_BASE', 'http://localhost:3000')).replace(/\/$/, '');
  const asBase = (opts.asBase || env('PANDA_UMA_AS_BASE', 'http://localhost:4000/uma')).replace(/\/$/, '');
  const pandaBase = (opts.pandaBase || env('PANDA_AGGREGATOR_BASE', 'http://localhost:8080')).replace(/\/$/, '');
  const skipPanda = opts.skipPandaCheck ||
    ['1', 'true', 'yes', 'on'].includes(env('PANDA_SKIP_AGGREGATOR_CHECK', '0').toLowerCase());

  const defaultPaths = 'alice/spo2/';
  const rawPaths = opts.resourcePaths
    ? opts.resourcePaths.join(',')
    : env('PANDA_PREFLIGHT_RESOURCES', defaultPaths);
  const resourcePaths = rawPaths.split(',').map((p) => p.trim()).filter(Boolean);

  const checks = [];

  checks.push(await checkCss(cssBase));
  checks.push(await checkUmaAs(asBase));

  if (!skipPanda) {
    checks.push(await checkPanda(pandaBase));
  }

  for (const resourcePath of resourcePaths) {
    checks.push(await checkProtectedResource(cssBase, resourcePath));
  }

  const failures = checks.filter((c) => !c.ok);
  const staleRegistrations = checks.filter((c) => c.isStaleRegistration);

  const summary = {
    passed: failures.length === 0,
    total_checks: checks.length,
    failed_checks: failures.length,
    stale_registrations: staleRegistrations.length,
    checks,
  };

  if (failures.length > 0) {
    const lines = ['[preflight-derived] PREFLIGHT FAILED:'];
    for (const failure of failures) {
      lines.push(`  FAIL: ${failure.label}`);
      for (const line of failure.detail.split('\n')) {
        lines.push(`    ${line}`);
      }
    }
    if (staleRegistrations.length > 0) {
      lines.push('');
      lines.push(`[preflight-derived] ${staleRegistrations.length} resource(s) have stale UMA registration (HTTP 500).`);
      lines.push(`[preflight-derived] No benchmark result will be written.`);
    }
    throw new Error(lines.join('\n'));
  }

  return summary;
}

module.exports = { runDerivedPreflight };

if (require.main === module) {
  const cssBase = env('PANDA_CSS_BASE', 'http://localhost:3000');
  const asBase = env('PANDA_UMA_AS_BASE', 'http://localhost:4000/uma');
  const pandaBase = env('PANDA_AGGREGATOR_BASE', 'http://localhost:8080');
  const resourcesRaw = env('PANDA_PREFLIGHT_RESOURCES', 'alice/spo2/');
  const resourcePaths = resourcesRaw.split(',').map((p) => p.trim()).filter(Boolean);

  console.log('[preflight-derived] Running strict derived-resource preflight...');
  console.log(`  CSS:      ${cssBase}`);
  console.log(`  UMA AS:   ${asBase}`);
  console.log(`  PANDA:    ${pandaBase}`);
  console.log(`  Resources: ${resourcePaths.join(', ')}`);

  runDerivedPreflight({ cssBase, asBase, pandaBase, resourcePaths })
    .then((summary) => {
      console.log('[preflight-derived] All checks passed.');
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
