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

async function main() {
  const resource = process.env.PANDA_UMA_RESOURCE || "http://localhost:3000/alice/README";
  const claimToken = process.env.PANDA_UMA_CLAIM_TOKEN || "http://localhost:3000/alice/profile/card#me";
  const claimTokenFormat =
    process.env.PANDA_UMA_CLAIM_TOKEN_FORMAT || "urn:solidlab:uma:claims:formats:webid";

  console.log(`[smoke:uma] Resource: ${resource}`);
  console.log(`[smoke:uma] Claim token: ${claimToken}`);
  console.log(`[smoke:uma] Claim format: ${claimTokenFormat}`);

  const initialResponse = await fetch(resource, { method: "GET" });
  console.log(`[smoke:uma] Initial request status: ${initialResponse.status}`);

  if (initialResponse.ok) {
    console.log("[smoke:uma] Resource is publicly accessible (no UMA challenge required).");
    process.exit(0);
  }

  const wwwAuthenticate = initialResponse.headers.get("WWW-Authenticate");
  const { tokenEndpoint, ticket } = parseAuthenticateHeader(wwwAuthenticate);
  console.log(`[smoke:uma] Parsed token endpoint: ${tokenEndpoint}`);
  console.log(`[smoke:uma] Parsed ticket: ${ticket}`);

  const tokenRequestBody = {
    grant_type: "urn:ietf:params:oauth:grant-type:uma-ticket",
    ticket,
    claim_token: encodeURIComponent(claimToken),
    claim_token_format: claimTokenFormat,
  };

  const tokenResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tokenRequestBody),
  });
  console.log(`[smoke:uma] Token endpoint status: ${tokenResponse.status}`);

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${errorBody}`);
  }

  const tokenPayload = await tokenResponse.json();
  const accessToken = tokenPayload.access_token;
  const tokenType = tokenPayload.token_type || "Bearer";

  if (!accessToken) {
    throw new Error("Token response missing access_token");
  }

  const authorizedResponse = await fetch(resource, {
    method: "GET",
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
    },
  });
  console.log(`[smoke:uma] Authorized request status: ${authorizedResponse.status}`);

  if (!authorizedResponse.ok) {
    const errorBody = await authorizedResponse.text();
    throw new Error(`Authorized request failed (${authorizedResponse.status}): ${errorBody}`);
  }

  const body = await authorizedResponse.text();
  console.log(`[smoke:uma] Authorized body length: ${body.length}`);
  console.log("[smoke:uma] UMA smoke test passed.");
}

main().catch((error) => {
  console.error(`[smoke:uma] FAILED: ${error.message}`);
  process.exit(1);
});

