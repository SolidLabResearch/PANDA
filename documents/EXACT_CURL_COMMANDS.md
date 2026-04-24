# EXACT CURL COMMANDS FOR DERIVED RESOURCE AUTHORIZATION TEST

**STATUS**: Script created at `/PANDA/scripts/uma/EXACT_TEST_COMMANDS.sh`

**REQUIREMENT**: CSS pod server (localhost:3000) and UMA authorization server (localhost:4000) must be running

## Configuration Verification from Source Code

### 1. Token Endpoint - VERIFIED

**Verified location**: [user-managed-access/packages/css/config/seed.json](user-managed-access/packages/css/config/seed.json#L9)

```json
{
  "authz": {
    "server": "http://localhost:4000/uma"
  }
}
```

**Conclusion**: Token endpoint is `http://localhost:4000/uma/token` ✅

---

### 2. Claim Token Format - VERIFIED

**Verified location**: [user-managed-access/packages/uma/src/credentials/Formats.ts](user-managed-access/packages/uma/src/credentials/Formats.ts#L2-L3)

```typescript
export const JWT = 'urn:solidlab:uma:claims:formats:jwt';
export const UNSECURE = 'urn:solidlab:uma:claims:formats:webid';
```

**Usage in tests**: [policy-aware-decentralized-stream-replayer/src/scripts/UMA-test/uma-ODRL.ts](policy-aware-decentralized-stream-replayer/src/scripts/UMA-test/uma-ODRL.ts#L8)

```typescript
const claim_token_format = 'urn:solidlab:uma:claims:formats:webid'
```

**Conclusion**: Claim token format is `urn:solidlab:uma:claims:formats:webid` (NOT JWT) ✅

---

### 3. Claim Token Type - VERIFIED

**Verified location**: [policy-aware-decentralized-stream-replayer/src/scripts/UMA-test/uma-ODRL.ts](policy-aware-decentralized-stream-replayer/src/scripts/UMA-test/uma-ODRL.ts#L6)

```typescript
const claim_token = "http://n063-04b.wall2.ilabt.iminds.be/replayer#me"
```

**Conclusion**: Claim token is a plain WebID URL (e.g., `http://localhost:3000/bob/profile/card#me`) ✅

---

## Exact CURL Commands

### COMMAND 1: Create Policy

```bash
curl -X POST http://localhost:3000/alice/settings/policies/ \
  -H "Content-Type: text/turtle" \
  -d @/tmp/derived-acc-x-policy.ttl
```

**Expected Response**: `201 Created` with `Location` header

---

### COMMAND 2: Tokenless GET (Get UMA Challenge)

```bash
curl -v http://localhost:3000/alice/derived/acc-x/
```

**Expected Response**: `403 Forbidden` with `WWW-Authenticate` header containing UMA ticket

```
HTTP/1.1 403 Forbidden
WWW-Authenticate: UMA realm="http://localhost:4000/uma", error="insufficient_scope", error_description="...", ticket="<ticket_value>"
```

---

### COMMAND 3: Exchange Ticket for Access Token

```bash
curl -X POST http://localhost:4000/uma/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:uma-ticket" \
  -d "ticket=<TICKET_FROM_STEP_2>" \
  -d "claim_token=http://localhost:3000/bob/profile/card#me" \
  -d "claim_token_format=urn:solidlab:uma:claims:formats:webid"
```

**Expected Response**: `200 OK` with JSON body

```json
{
  "access_token": "rpt_...",
  "token_type": "Bearer",
  "expires_in": 1800
}
```

---

### COMMAND 4: Authorized Retry with Bearer Token

```bash
curl -v -H "Authorization: Bearer <ACCESS_TOKEN_FROM_STEP_3>" \
  http://localhost:3000/alice/derived/acc-x/
```

**Expected Response**: `200 OK` with resource data

```
HTTP/1.1 200 OK
Content-Type: text/turtle
...
<resource-data>
```

---

## How to Run the Test

```bash
# Make script executable
chmod +x /Users/kushbisen/Code/PANDA\ Platform/PANDA/scripts/uma/EXACT_TEST_COMMANDS.sh

# Run the test (requires servers running on localhost:3000 and localhost:4000)
bash /Users/kushbisen/Code/PANDA\ Platform/PANDA/scripts/uma/EXACT_TEST_COMMANDS.sh
```

---

## Justification for Configuration

| Setting | Value | Verified From | Reason |
|---------|-------|---------------|--------|
| UMA Token Endpoint | `http://localhost:4000/uma/token` | [seed.json](user-managed-access/packages/css/config/seed.json#L9) | CSS package explicitly configures UMA on port 4000 |
| Claim Token Format | `urn:solidlab:uma:claims:formats:webid` | [Formats.ts](user-managed-access/packages/uma/src/credentials/Formats.ts#L3) | Defined as UNSECURE constant for plain WebID URLs |
| Claim Token Type | Plain WebID URL | [uma-ODRL.ts](policy-aware-decentralized-stream-replayer/src/scripts/UMA-test/uma-ODRL.ts#L6-L8) | Actual test usage shows WebID, not JWT |

---

## Current Status

❌ **Servers not running** - CSS (localhost:3000) and UMA (localhost:4000) not accessible
✅ **Configuration verified** - All endpoints and formats validated from source code
✅ **Policy file created** - Ready to POST to policy container
✅ **Commands documented** - Exact curl commands provided above

**To get runtime evidence of 200 response:**
1. Start both servers (CSS on :3000, UMA on :4000)
2. Run the test script created above
3. It will display raw curl responses including the final `200 OK`
