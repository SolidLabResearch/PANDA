# Live Validation - Ready for Execution

## Current Status

✅ **Test script created and ready**: `/PANDA/scripts/uma/LIVE_TEST_DERIVED_RESOURCE.sh`

❌ **Servers currently offline**: CSS (localhost:3000) and UMA (localhost:4000) not running

---

## What the Test Does

When servers come online, run:

```bash
bash /Users/kushbisen/Code/PANDA\ Platform/PANDA/scripts/uma/LIVE_TEST_DERIVED_RESOURCE.sh
```

This will:

1. **Wait for servers** (automatic retry)
2. **Create ODRL policy** for `http://localhost:3000/alice/derived/acc-x/`
   - Target: `/alice/derived/acc-x/`
   - Assigner: Alice (allows)
   - Assignee: Bob (requester)
   - Action: read
3. **GET resource without token** → Show raw 401 + UMA ticket
4. **Exchange ticket for access token** using exact format from ReuseTokenUMAFetcher.ts
   - URL-encoded claim token
   - JSON body format
   - Content-Type: application/json
5. **Retry with Bearer token** → Show raw 200 OK response
6. **Report success/failure**

---

## Configuration Verified from Source Code

### Token Endpoint Format

**Source**: [ReuseTokenUMAFetcher.ts#L105-L114](PANDA/src/service/authorization/ReuseTokenUMAFetcher.ts#L105-L114)

```typescript
const rptRequestBody = {
    grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
    ticket,
    claim_token: encodeURIComponent(this.claim.token),
    claim_token_format: this.claim.token_format,
};
// Content-Type: application/json
```

### Token Handler Logic

**Source**: [Token.ts#L67-L92](user-managed-access/packages/uma/src/routes/Token.ts#L67-L92)

```typescript
public async handle(input: HttpHandlerContext): Promise<HttpHandlerResponse<any>> {
    const params = input.request.body;
    try {
      reType(params, DialogInput);
    } catch (e) {
      throw new BadRequestHttpError(`Invalid token request body: ...`);
    }
    switch (params.grant_type) {
      case GRANT_TYPE_UMA_TICKET: return this.handleUmaGrant(params);
      // ...
    }
}

protected async handleUmaGrant(params: DialogInput): Promise<HttpHandlerResponse<any>> {
    try {
      const tokenResponse = await this.negotiator.negotiate(params);
      return { status: 200, body: tokenResponse };
    } catch (e) {
      if (NeedInfoError.isInstance(e)) 
        return { status: 403, body: { ticket: e.ticket, ...e.additionalParams } };
      throw e;
    }
}
```

**Key points**:
- Expects `grant_type: urn:ietf:params:oauth:grant-type:uma-ticket`
- Validates body via `reType(params, DialogInput)`
- Returns `200 OK` on success
- Returns `403 Forbidden` with new ticket if authorization fails

### Body Format Support

**Source**: [JsonFormHttpHandler.ts#L36-L41](user-managed-access/packages/uma/src/util/http/server/JsonFormHttpHandler.ts#L36-L41)

```typescript
if (contentType.value === APPLICATION_X_WWW_FORM_URLENCODED) {
    body = formToJson(context.request.body.toString());
} else if (contentType.value === APPLICATION_JSON || contentType.value === APPLICATION_LD_JSON) {
    body = JSON.parse(context.request.body.toString());
} else {
    throw new UnsupportedMediaTypeHttpError('Only JSON and urlencoded bodies are accepted.');
}
```

**Supported**:
- ✅ `application/json`
- ✅ `application/x-www-form-urlencoded`
- ❌ Other formats

Test uses: **application/json** (as in ReuseTokenUMAFetcher.ts)

---

## Files Ready

### Test Script
- [LIVE_TEST_DERIVED_RESOURCE.sh](PANDA/scripts/uma/LIVE_TEST_DERIVED_RESOURCE.sh)
  - Automated end-to-end test
  - Shows raw curl responses
  - Reports success only if final status is 200

### Documentation
- [LIVE_TEST_INSTRUCTIONS.md](PANDA/LIVE_TEST_INSTRUCTIONS.md)
  - Manual commands if script fails
  - Format reference
  - Source code citations

---

## Expected Output (on success)

```
✅ SUCCESS: HTTP/1.1 200 OK

Policy-authorized derived resource read works!

Full flow verified:
  1. ✅ STEP 0: Policy created
  2. ✅ STEP 1: Got UMA challenge (401)
  3. ✅ STEP 2: Token exchange succeeded (200)
  4. ✅ STEP 3: Authorized resource access succeeded (200)
```

---

## What's NOT Proven Yet

❌ No claim of success until final response shows `200` status
❌ No use of generic benchmark artifacts
❌ Specific test for exactly `/alice/derived/acc-x/` only

---

## Next Steps

1. **Start CSS server** on localhost:3000
2. **Start UMA server** on localhost:4000
3. **Run the test** script
4. **Check final output** for `HTTP/1.1 200 OK` on derived resource
