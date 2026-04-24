#!/usr/bin/env node

function parseAuthenticateHeader(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) {
    throw new Error("Missing WWW-Authenticate header");
  }

  const headerWithoutScheme = wwwAuthenticateHeader.replace(/^UMA\s+/i, "");
  const params = Object.fromEntries(
    headerWithoutScheme.split(/\s*,\s*/).map((param) => {
      const separatorIndex = param.indexOf("=");
      if (separatorIndex < 0) {
        return [param.trim(), ""];
      }
      const key = param.slice(0, separatorIndex).trim();
      const value = param.slice(separatorIndex + 1).trim().replace(/^"|"$/g, "");
      return [key, value];
    })
  );

  const asUri = params.as_uri;
  const ticket = params.ticket;

  if (!asUri || !ticket) {
    throw new Error(`Invalid UMA WWW-Authenticate header: ${wwwAuthenticateHeader}`);
  }

  const tokenEndpoint = new URL("token", asUri.endsWith("/") ? asUri : `${asUri}/`).toString();
  return { tokenEndpoint, ticket };
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function safeRead(filePath) {
  if (!filePath) return "";
  try {
    return require("fs").readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertOdrlProof(logChunk, resource, allowClaim, denyClaim) {
  assert(/OdrlAuthorizer/.test(logChunk), "ODRL proof missing: OdrlAuthorizer log marker not found");
  const allowPattern = new RegExp(
    `Evaluating Request \\[S R AR\\]: \\[${escapeRegExp(allowClaim)} ${escapeRegExp(resource)} `
  );
  const denyPattern = new RegExp(
    `Evaluating Request \\[S R AR\\]: \\[${escapeRegExp(denyClaim)} ${escapeRegExp(resource)} `
  );
  assert(allowPattern.test(logChunk), `ODRL proof missing allow evaluation log for ${allowClaim}`);
  assert(denyPattern.test(logChunk), `ODRL proof missing deny evaluation log for ${denyClaim}`);
}

async function challenge(resource, strictStatus = true) {
  const response = await fetch(resource, { method: "GET" });
  const wwwAuthenticate = response.headers.get("WWW-Authenticate");
  const info = {
    status: response.status,
    wwwAuthenticate: wwwAuthenticate || "",
  };
  if (strictStatus) {
    assert(response.status === 401, `Expected 401 UMA challenge, got ${response.status}`);
  } else {
    assert(response.status >= 400, `Expected non-2xx challenge status, got ${response.status}`);
  }
  const parsed = parseAuthenticateHeader(wwwAuthenticate);
  return { ...info, ...parsed };
}

async function exchangeToken(tokenEndpoint, ticket, claimToken, claimTokenFormat) {
  const tokenRequestBody = {
    grant_type: "urn:ietf:params:oauth:grant-type:uma-ticket",
    ticket,
    claim_token: encodeURIComponent(claimToken),
    claim_token_format: claimTokenFormat,
  };

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokenRequestBody),
  });

  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }

  return { status: response.status, raw, json };
}

async function authorizedFetch(resource, tokenType, accessToken) {
  const response = await fetch(resource, {
    method: "GET",
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
    },
  });
  const body = await response.text();
  return { status: response.status, body };
}

async function ensureSimpleAllowPolicy(resource, ownerWebId, assigneeWebId, policyEndpoint) {
  const uid = `urn:uma:smoke:${Date.now()}:${Math.floor(Math.random() * 10000)}`;
  const policy = `
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <http://example.org/>
ex:agreement a odrl:Agreement ; odrl:uid <${uid}> ; odrl:permission ex:permission .
ex:permission a odrl:Permission ;
  odrl:target <${resource}> ;
  odrl:assigner <${ownerWebId}> ;
  odrl:assignee <${assigneeWebId}> ;
  odrl:action odrl:read .
`.trim();
  const auth = `WebID ${encodeURIComponent(ownerWebId)}`;
  const response = await fetch(policyEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "text/turtle",
      Authorization: auth,
    },
    body: policy,
  });
  if (!(response.status === 201 || response.status === 409)) {
    const body = await response.text().catch(() => "");
    throw new Error(`Policy bootstrap failed (${response.status}): ${body}`);
  }
  return response.status;
}

async function main() {
  const resource = env("PANDA_UMA_RESOURCE", "http://localhost:3000/alice/derived/acc-x/");
  const wrongTargetResource = env("PANDA_UMA_WRONG_TARGET_RESOURCE", "http://localhost:3000/alice/derived/acc-y/");
  const allowClaimToken = env("PANDA_UMA_CLAIM_TOKEN", "http://localhost:3000/bob/profile/card#me");
  const denyClaimToken = env("PANDA_UMA_DENY_CLAIM_TOKEN", "http://localhost:3000/demo/profile/card#me");
  const invalidClaimToken = env("PANDA_UMA_INVALID_CLAIM_TOKEN", "not-a-webid");
  const claimTokenFormat = env("PANDA_UMA_CLAIM_TOKEN_FORMAT", "urn:solidlab:uma:claims:formats:webid");
  const requireChallenge = env("PANDA_UMA_REQUIRE_UMA_CHALLENGE", "true").toLowerCase() === "true";
  const requireDenyPath = env("PANDA_UMA_REQUIRE_DENY_PATH", "true").toLowerCase() === "true";
  const strict401 = env("PANDA_UMA_REQUIRE_401_CHALLENGE", "true").toLowerCase() === "true";
  const requireOdrlProof = env("PANDA_UMA_REQUIRE_ODRL_PROOF", "true").toLowerCase() === "true";
  const odrlLogFile = env("PANDA_UMA_ODRL_LOG_FILE", "");
  const bootstrapPolicy = env("PANDA_UMA_BOOTSTRAP_ALLOW_POLICY", "true").toLowerCase() === "true";
  const policyEndpoint = env("PANDA_UMA_POLICY_ENDPOINT", "http://localhost:4000/uma/policies");
  const ownerWebId = env("PANDA_UMA_POLICY_OWNER_WEBID", "http://localhost:3000/alice/profile/card#me");
  const odrlLogBefore = odrlLogFile ? safeRead(odrlLogFile) : "";

  console.log(`[smoke:uma] Resource=${resource}`);
  console.log(`[smoke:uma] WrongTarget=${wrongTargetResource}`);
  console.log(`[smoke:uma] AllowClaim=${allowClaimToken}`);
  console.log(`[smoke:uma] DenyClaim=${denyClaimToken}`);
  if (bootstrapPolicy) {
    const policyStatus = await ensureSimpleAllowPolicy(resource, ownerWebId, allowClaimToken, policyEndpoint);
    console.log(`[smoke:uma] Policy bootstrap status=${policyStatus}`);
  }

  const c1 = await challenge(resource, strict401);
  console.log(`[smoke:uma] Challenge status=${c1.status}`);
  console.log(`[smoke:uma] Challenge header=${c1.wwwAuthenticate}`);
  if (requireChallenge) {
    assert(c1.wwwAuthenticate.includes("ticket="), "UMA challenge missing ticket parameter");
  }

  const allowExchange = await exchangeToken(c1.tokenEndpoint, c1.ticket, allowClaimToken, claimTokenFormat);
  console.log(`[smoke:uma] Allow exchange status=${allowExchange.status}`);
  assert(allowExchange.status === 200, `Expected allow exchange 200, got ${allowExchange.status}: ${allowExchange.raw}`);
  const accessToken = allowExchange.json?.access_token;
  const tokenType = allowExchange.json?.token_type || "Bearer";
  assert(accessToken, "Allow exchange response missing access_token");

  const allowFetch = await authorizedFetch(resource, tokenType, accessToken);
  console.log(`[smoke:uma] Allow fetch status=${allowFetch.status}`);
  assert(allowFetch.status === 200, `Expected allow fetch 200, got ${allowFetch.status}`);

  const wrongTargetFetch = await authorizedFetch(wrongTargetResource, tokenType, accessToken);
  console.log(`[smoke:uma] Wrong-target fetch status=${wrongTargetFetch.status}`);
  assert(
    wrongTargetFetch.status === 401 || wrongTargetFetch.status === 403,
    `Expected wrong-target rejection (401/403), got ${wrongTargetFetch.status}`
  );

  const denyChallenge = await challenge(resource, strict401);
  const denyExchange = await exchangeToken(
    denyChallenge.tokenEndpoint,
    denyChallenge.ticket,
    denyClaimToken,
    claimTokenFormat
  );
  console.log(`[smoke:uma] Deny exchange status=${denyExchange.status}`);
  if (requireDenyPath) {
    assert(denyExchange.status === 403, `Expected deny exchange 403, got ${denyExchange.status}: ${denyExchange.raw}`);
  }

  const invalidChallenge = await challenge(resource, strict401);
  const invalidExchange = await exchangeToken(
    invalidChallenge.tokenEndpoint,
    invalidChallenge.ticket,
    invalidClaimToken,
    claimTokenFormat
  );
  console.log(`[smoke:uma] Invalid-claim exchange status=${invalidExchange.status}`);
  assert(
    invalidExchange.status >= 400,
    `Expected invalid-claim exchange failure (4xx/5xx), got ${invalidExchange.status}`
  );

  const reuseFetch = await authorizedFetch(resource, tokenType, accessToken);
  console.log(`[smoke:uma] Reuse fetch status=${reuseFetch.status}`);
  assert(reuseFetch.status === 200, `Expected reuse fetch 200, got ${reuseFetch.status}`);

  if (requireOdrlProof) {
    assert(odrlLogFile, "PANDA_UMA_ODRL_LOG_FILE is required when PANDA_UMA_REQUIRE_ODRL_PROOF=true");
    const odrlLogAfter = safeRead(odrlLogFile);
    const delta = odrlLogAfter.slice(odrlLogBefore.length);
    assertOdrlProof(delta, resource, allowClaimToken, denyClaimToken);
    console.log(`[smoke:uma] ODRL proof verified in ${odrlLogFile}`);
  }

  console.log("[smoke:uma] UMA strict smoke/preflight passed.");
}

main().catch((error) => {
  console.error(`[smoke:uma] FAILED: ${error.message}`);
  process.exit(1);
});
