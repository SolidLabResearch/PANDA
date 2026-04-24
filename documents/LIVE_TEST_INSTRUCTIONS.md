# Live Test Commands for Derived Resource Authorization

## Ready-to-Run Test Script

```bash
chmod +x /Users/kushbisen/Code/PANDA Platform/PANDA/scripts/uma/LIVE_TEST_DERIVED_RESOURCE.sh
bash /Users/kushbisen/Code/PANDA Platform/PANDA/scripts/uma/LIVE_TEST_DERIVED_RESOURCE.sh
```

This script will:
1. Wait for CSS (localhost:3000) and UMA (localhost:4000) servers
2. Create ODRL policy for `/alice/derived/acc-x/`
3. GET the resource without token (expect UMA challenge)
4. Exchange ticket for access token using exact format from code
5. Retry with Bearer token (should get 200 OK)
6. Show raw response headers and body at each step

---

## Token Endpoint Body Format - Verified from Source Code

### Location: [PANDA/src/service/authorization/ReuseTokenUMAFetcher.ts#L105-L108](PANDA/src/service/authorization/ReuseTokenUMAFetcher.ts#L105-L108)

```typescript
const rptRequestBody = {
    grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
    ticket,
    claim_token: encodeURIComponent(this.claim.token),
    claim_token_format: this.claim.token_format,
};
```

**Content-Type**: `application/json` (line 114)

**Key points**:
- claim_token is URL-encoded using `encodeURIComponent()`
- claim_token_format is passed as-is: `urn:solidlab:uma:claims:formats:webid`
- grant_type is: `urn:ietf:params:oauth:grant-type:uma-ticket`

### Token.ts Handler - Verified from Source Code

**Location**: [user-managed-access/packages/uma/src/routes/Token.ts#L67-92](user-managed-access/packages/uma/src/routes/Token.ts#L67-L92)

```typescript
public async handle(input: HttpHandlerContext): Promise<HttpHandlerResponse<any>> {
    this.logger.info(`Received token request.`);
    const params = input.request.body;

    try {
      reType(params, DialogInput);
    } catch (e) {
      throw new BadRequestHttpError(`Invalid token request body: ${e instanceof Error ? e.message : ''}`);
    }

    switch (params.grant_type) {
      case GRANT_TYPE_UMA_TICKET: return this.handleUmaGrant(params);
      // ...
    }
}

protected async handleUmaGrant(params: DialogInput): Promise<HttpHandlerResponse<any>> {
    try {
      const tokenResponse = await this.negotiator.negotiate(params);
      return {
        status: 200,
        body: tokenResponse
      };
    } catch (e) {
      if (NeedInfoError.isInstance(e)) return ({
        status: 403,
        body: {
          ticket: e.ticket,
          ...e.additionalParams
        }
      });
      throw e;
    }
}
```

**Logic**:
1. Expects `grant_type` to be `urn:ietf:params:oauth:grant-type:uma-ticket`
2. Validates body structure against `DialogInput` reType schema
3. On success: returns `200` with tokenResponse
4. On failure (NeedInfoError): returns `403` with new ticket (e.g., if policy needs to be created)

### JsonFormHttpHandler - Body Format Support

**Location**: [user-managed-access/packages/uma/src/util/http/server/JsonFormHttpHandler.ts#L36-41](user-managed-access/packages/uma/src/util/http/server/JsonFormHttpHandler.ts#L36-L41)

```typescript
if (contentType.value === APPLICATION_X_WWW_FORM_URLENCODED) {
    body = formToJson(context.request.body.toString());
} else if (contentType.value === APPLICATION_JSON || contentType.value === APPLICATION_LD_JSON) {
    body = JSON.parse(context.request.body.toString());
} else {
    throw new UnsupportedMediaTypeHttpError('Only JSON and urlencoded bodies are accepted.');
}
```

**Supported formats**:
- ✅ `application/json` (line 39) - parsed as JSON
- ✅ `application/x-www-form-urlencoded` (line 36-37) - converted to JSON
- ❌ Other formats - rejected

---

## Manual Test Commands (if script fails)

### Step 0: Create Policy

```bash
cat > /tmp/policy.ttl << 'EOF'
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <http://example.org/>

ex:derivedAccXAgreement a odrl:Agreement ;
    odrl:permission ex:derivedAccXPermission .

ex:derivedAccXPermission a odrl:Permission ;
    odrl:target <http://localhost:3000/alice/derived/acc-x/> ;
    odrl:assigner <http://localhost:3000/alice/profile/card#me> ;
    odrl:assignee <http://localhost:3000/bob/profile/card#me> ;
    odrl:action odrl:read .
EOF

curl -X POST http://localhost:3000/alice/settings/policies/ \
  -H "Content-Type: text/turtle" \
  -d @/tmp/policy.ttl
```

**Expected**: `201 Created`

### Step 1: Get Derived Resource (Get UMA Challenge)

```bash
curl -i http://localhost:3000/alice/derived/acc-x/
```

**Expected**: `401 Unauthorized` with `WWW-Authenticate: UMA realm="...", ticket="..."`

Extract ticket:
```bash
TICKET=$(curl -s -i http://localhost:3000/alice/derived/acc-x/ | \
  grep -o 'ticket="[^"]*"' | cut -d'"' -f2)
echo $TICKET
```

### Step 2: Exchange Ticket for Access Token

```bash
TICKET="<from_step_1>"
BOB_WEBID="http://localhost:3000/bob/profile/card#me"
ENCODED=$(node -e "console.log(encodeURIComponent('$BOB_WEBID'))")

curl -X POST http://localhost:4000/uma/token \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"urn:ietf:params:oauth:grant-type:uma-ticket\",
    \"ticket\": \"$TICKET\",
    \"claim_token\": \"$ENCODED\",
    \"claim_token_format\": \"urn:solidlab:uma:claims:formats:webid\"
  }" | jq .
```

**Expected**: `200 OK` with `{"access_token": "rpt_...", "token_type": "Bearer", ...}`

Extract access token:
```bash
ACCESS_TOKEN=$(curl -s -X POST http://localhost:4000/uma/token \
  -H "Content-Type: application/json" \
  -d "{...}" | jq -r '.access_token')
echo $ACCESS_TOKEN
```

### Step 3: Authorized Retry with Bearer Token

```bash
ACCESS_TOKEN="<from_step_2>"

curl -i -H "Authorization: Bearer $ACCESS_TOKEN" \
  http://localhost:3000/alice/derived/acc-x/
```

**Expected**: `200 OK` with resource data

---

## Success Criteria

✅ **Success**: Final curl returns `HTTP/1.1 200 OK` (or similar 2xx status)

❌ **Failure**: Final curl returns `403`, `401`, or any non-2xx status

---

## Files Created

These are the exact files referenced in this document:

| File | Purpose |
|------|---------|
| [LIVE_TEST_DERIVED_RESOURCE.sh](PANDA/scripts/uma/LIVE_TEST_DERIVED_RESOURCE.sh) | Automated test (run this when servers are ready) |
| [ReuseTokenUMAFetcher.ts](PANDA/src/service/authorization/ReuseTokenUMAFetcher.ts) | Token request format (lines 105-108) |
| [Token.ts](user-managed-access/packages/uma/src/routes/Token.ts) | Token handler (lines 67-92) |
| [JsonFormHttpHandler.ts](user-managed-access/packages/uma/src/util/http/server/JsonFormHttpHandler.ts) | Body format support (lines 36-41) |
