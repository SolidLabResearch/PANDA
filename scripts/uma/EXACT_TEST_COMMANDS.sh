#!/bin/bash
# EXACT VALIDATED CURL COMMANDS FOR DERIVED RESOURCE AUTHORIZATION TEST
# Endpoints and formats verified from source code configuration
# 
# Prerequisites: CSS ( localhost:3000) and UMA (localhost:4000) servers must be running

set -e

# ============================================================================
# VERIFIED CONFIGURATION FROM SOURCE CODE
# ============================================================================
# Token endpoint: http://localhost:4000/uma (verified from seed.json line 9)
# Claim token format: urn:solidlab:uma:claims:formats:webid (verified from Formats.ts line 3)
# Claim token type: Plain WebID URL (not JWT)

ALICE_POLICY_CONTAINER="http://localhost:3000/alice/settings/policies/"
DERIVED_RESOURCE="http://localhost:3000/alice/derived/acc-x/"
ALICE_WEBID="http://localhost:3000/alice/profile/card#me"
BOB_WEBID="http://localhost:3000/bob/profile/card#me"
UMA_TOKEN_ENDPOINT="http://localhost:4000/uma/token"
CLAIM_TOKEN_FORMAT="urn:solidlab:uma:claims:formats:webid"

# ============================================================================
# STEP 1: CREATE ODRL POLICY FOR DERIVED RESOURCE
# ============================================================================
echo "STEP 1: Create ODRL policy targeting derived resource"
echo "========================================================"
echo ""

cat > /tmp/derived-acc-x-policy.ttl << 'POLICY'
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <http://example.org/>
PREFIX dcterms: <http://purl.org/dc/terms/>

ex:derivedAccXAgreement a odrl:Agreement ;
    odrl:uid <urn:ucp:policy:test-derived-acc-x> ;
    dcterms:description "Allow Bob to read Alice's derived accelerometer-x data" ;
    odrl:permission ex:derivedAccXPermission .

ex:derivedAccXPermission a odrl:Permission ;
    odrl:target <http://localhost:3000/alice/derived/acc-x/> ;
    odrl:assigner <http://localhost:3000/alice/profile/card#me> ;
    odrl:assignee <http://localhost:3000/bob/profile/card#me> ;
    odrl:action odrl:read .
POLICY

echo "Creating policy file at /tmp/derived-acc-x-policy.ttl"
cat /tmp/derived-acc-x-policy.ttl
echo ""
echo "Posting policy to: $ALICE_POLICY_CONTAINER"
echo ""

POLICY_RESPONSE=$(curl -s -i -X POST \
  "$ALICE_POLICY_CONTAINER" \
  -H "Content-Type: text/turtle" \
  -d @/tmp/derived-acc-x-policy.ttl)

echo "POLICY CREATION RESPONSE:"
echo "$POLICY_RESPONSE"
echo ""
echo ""

# ============================================================================
# STEP 2: GET DERIVED RESOURCE WITHOUT TOKEN
# ============================================================================
echo "STEP 2: Tokenless GET on /alice/derived/acc-x/"
echo "================================================"
echo ""

CURL_CMD_1='curl -v http://localhost:3000/alice/derived/acc-x/'
echo "EXACT CURL COMMAND:"
echo "$CURL_CMD_1"
echo ""
echo "RESPONSE:"

DERIVED_RESPONSE=$(curl -s -i -X GET "http://localhost:3000/alice/derived/acc-x/")
echo "$DERIVED_RESPONSE"
echo ""

# Extract ticket
TICKET=$(echo "$DERIVED_RESPONSE" | grep -o 'ticket="[^"]*"' | head -1 | cut -d'"' -f2)
if [ -z "$TICKET" ]; then
  echo "ERROR: Could not extract ticket from response"
  exit 1
fi

echo "Extracted UMA ticket: $TICKET"
echo ""
echo ""

# ============================================================================
# STEP 3: EXCHANGE TICKET FOR ACCESS TOKEN
# ============================================================================
echo "STEP 3: Exchange ticket for access token"
echo "========================================="
echo ""

echo "CONFIGURATION (verified from source code):"
echo "  - Token endpoint: $UMA_TOKEN_ENDPOINT"
echo "    Source: user-managed-access/packages/css/config/seed.json line 9"
echo ""
echo "  - Claim token format: $CLAIM_TOKEN_FORMAT"
echo "    Source: user-managed-access/packages/uma/src/credentials/Formats.ts line 3"
echo "    Type: UNSECURE (plain WebID, not JWT)"
echo ""
echo "  - Claim token (Bob WebID): $BOB_WEBID"
echo ""

CURL_CMD_2="curl -X POST $UMA_TOKEN_ENDPOINT \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=urn:ietf:params:oauth:grant-type:uma-ticket' \
  -d \"ticket=$TICKET\" \
  -d \"claim_token=$BOB_WEBID\" \
  -d 'claim_token_format=$CLAIM_TOKEN_FORMAT'"

echo "EXACT CURL COMMAND:"
echo "$CURL_CMD_2"
echo ""
echo "RAW RESPONSE:"

TOKEN_RESPONSE=$(curl -s -X POST "$UMA_TOKEN_ENDPOINT" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=urn:ietf:params:oauth:grant-type:uma-ticket" \
  -d "ticket=$TICKET" \
  -d "claim_token=$BOB_WEBID" \
  -d "claim_token_format=$CLAIM_TOKEN_FORMAT")

echo "$TOKEN_RESPONSE"
echo ""

# Pretty-print if JSON
if command -v jq &> /dev/null; then
  echo "FORMATTED JSON:"
  echo "$TOKEN_RESPONSE" | jq . 2>/dev/null || echo "(not valid JSON)"
else
  echo "(install jq to see formatted JSON)"
fi
echo ""

# Extract access token
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$ACCESS_TOKEN" ]; then
  echo "ERROR: No access_token in response. Full response:"
  echo "$TOKEN_RESPONSE"
  exit 1
fi

echo "Extracted access_token: ${ACCESS_TOKEN:0:50}..."
echo ""
echo ""

# ============================================================================
# STEP 4: AUTHORIZED RETRY WITH BEARER TOKEN
# ============================================================================
echo "STEP 4: Authorized retry with Bearer token"
echo "==========================================="
echo ""

CURL_CMD_3="curl -v -H \"Authorization: Bearer <access_token>\" http://localhost:3000/alice/derived/acc-x/"
echo "EXACT CURL COMMAND:"
echo "$CURL_CMD_3"
echo ""
echo "RAW RESPONSE HEADERS & BODY:"

AUTHORIZED_RESPONSE=$(curl -s -i -H "Authorization: Bearer $ACCESS_TOKEN" \
  "http://localhost:3000/alice/derived/acc-x/")

echo "$AUTHORIZED_RESPONSE"
echo ""
echo ""

# ============================================================================
# FINAL VERDICT
# ============================================================================
echo "FINAL RESULT:"
echo "============"
echo ""

AUTH_STATUS=$(echo "$AUTHORIZED_RESPONSE" | head -1)
if echo "$AUTH_STATUS" | grep -q "200"; then
  echo "✅ SUCCESS: $AUTH_STATUS"
  echo ""
  echo "Policy-authorized derived resource read works!"
else
  echo "❌ FAILED: $AUTH_STATUS"
  exit 1
fi
