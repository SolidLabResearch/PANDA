#!/bin/bash
# DERIVED RESOURCE AUTHORIZATION TEST - LIVE VALIDATION
# Tests authorization flow for http://localhost:3000/alice/derived/acc-x/
# Exact format from: PANDA/src/service/authorization/ReuseTokenUMAFetcher.ts

set -e

# Configuration
ALICE_POLICY_CONTAINER="http://localhost:3000/alice/settings/policies/"
DERIVED_RESOURCE="http://localhost:3000/alice/derived/acc-x/"
ALICE_WEBID="http://localhost:3000/alice/profile/card#me"
BOB_WEBID="http://localhost:3000/bob/profile/card#me"
UMA_TOKEN_ENDPOINT="http://localhost:4000/uma/token"
CLAIM_TOKEN_FORMAT="urn:solidlab:uma:claims:formats:webid"

echo "=========================================="
echo "DERIVED RESOURCE AUTHORIZATION TEST"
echo "Resource: $DERIVED_RESOURCE"
echo "=========================================="
echo ""

# Check if servers are running
echo "Checking server availability..."
for i in {1..3}; do
  if curl -s -f http://localhost:3000/ > /dev/null 2>&1 && curl -s -f http://localhost:4000/uma > /dev/null 2>&1; then
    echo "✅ Servers are running"
    break
  fi
  if [ $i -lt 3 ]; then
    echo "⏳ Servers not ready, waiting... ($i/3)"
    sleep 2
  else
    echo "❌ ERROR: Servers not running on localhost:3000 and localhost:4000"
    exit 1
  fi
done
echo ""

# ================================================================
# STEP 0: CREATE ODRL POLICY FOR DERIVED RESOURCE
# ================================================================
echo "STEP 0: Create ODRL policy for derived resource"
echo "==============================================="
echo ""

cat > /tmp/derived-acc-x-policy.ttl << 'POLICY'
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <http://example.org/>
PREFIX dcterms: <http://purl.org/dc/terms/>

ex:derivedAccXAgreement a odrl:Agreement ;
    odrl:permission ex:derivedAccXPermission .

ex:derivedAccXPermission a odrl:Permission ;
    odrl:target <http://localhost:3000/alice/derived/acc-x/> ;
    odrl:assigner <http://localhost:3000/alice/profile/card#me> ;
    odrl:assignee <http://localhost:3000/bob/profile/card#me> ;
    odrl:action odrl:read .
POLICY

echo "Policy target: $DERIVED_RESOURCE"
echo "Policy assigner: $ALICE_WEBID"
echo "Policy assignee: $BOB_WEBID"
echo "Policy action: odrl:read"
echo ""
echo "Creating policy in: $ALICE_POLICY_CONTAINER"
echo ""

POLICY_RESPONSE=$(curl -s -i -X POST \
  "$ALICE_POLICY_CONTAINER" \
  -H "Content-Type: text/turtle" \
  -d @/tmp/derived-acc-x-policy.ttl)

POLICY_STATUS=$(echo "$POLICY_RESPONSE" | head -1)
echo "POLICY CREATION RESPONSE:"
echo "$POLICY_STATUS"

if ! echo "$POLICY_STATUS" | grep -q "201"; then
  echo ""
  echo "❌ ERROR: Policy creation failed"
  echo "Full response:"
  echo "$POLICY_RESPONSE"
  exit 1
fi

echo "✅ Policy created successfully"
echo ""
sleep 1

# ================================================================
# STEP 1: GET DERIVED RESOURCE WITHOUT TOKEN
# ================================================================
echo "STEP 1: Tokenless GET on $DERIVED_RESOURCE"
echo "============================================"
echo ""

CURL_CMD_1="curl -i $DERIVED_RESOURCE"
echo "CURL COMMAND:"
echo "$CURL_CMD_1"
echo ""

DERIVED_RESPONSE=$(curl -s -i "$DERIVED_RESOURCE")
echo "RAW RESPONSE HEADERS & BODY:"
echo "$DERIVED_RESPONSE"
echo ""

# Extract ticket
TICKET=$(echo "$DERIVED_RESPONSE" | grep -o 'ticket="[^"]*"' | head -1 | cut -d'"' -f2)
if [ -z "$TICKET" ]; then
  echo "❌ ERROR: Could not extract UMA ticket from response"
  exit 1
fi

RESPONSE_STATUS=$(echo "$DERIVED_RESPONSE" | head -1)
echo "Response status: $RESPONSE_STATUS"
echo "Extracted ticket: $TICKET"
echo ""
sleep 1

# ================================================================
# STEP 2: EXCHANGE TICKET FOR ACCESS TOKEN
# ================================================================
echo "STEP 2: Exchange ticket for access token"
echo "========================================="
echo ""

echo "Token endpoint: $UMA_TOKEN_ENDPOINT"
echo ""
echo "Claim token format (from Formats.ts): $CLAIM_TOKEN_FORMAT"
echo "Claim token (Bob WebID): $BOB_WEBID"
echo ""
echo "Request body format (verified from ReuseTokenUMAFetcher.ts):"
echo "  - grant_type: urn:ietf:params:oauth:grant-type:uma-ticket"
echo "  - ticket: <extracted>"
echo "  - claim_token: <URL-encoded WebID>"
echo "  - claim_token_format: $CLAIM_TOKEN_FORMAT"
echo "  - Content-Type: application/json"
echo ""

# Encode claim token as done in ReuseTokenUMAFetcher.ts line 105
ENCODED_CLAIM_TOKEN=$(node -e "console.log(encodeURIComponent('$BOB_WEBID'))")

TOKEN_REQUEST_BODY=$(cat <<EOF
{
  "grant_type": "urn:ietf:params:oauth:grant-type:uma-ticket",
  "ticket": "$TICKET",
  "claim_token": "$ENCODED_CLAIM_TOKEN",
  "claim_token_format": "$CLAIM_TOKEN_FORMAT"
}
EOF
)

CURL_CMD_2="curl -X POST $UMA_TOKEN_ENDPOINT \
  -H 'Content-Type: application/json' \
  -d '<token_request_body>'"

echo "CURL COMMAND (simplified):"
echo "$CURL_CMD_2"
echo ""
echo "ACTUAL REQUEST BODY:"
echo "$TOKEN_REQUEST_BODY" | jq .
echo ""

TOKEN_RESPONSE=$(curl -s -X POST "$UMA_TOKEN_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "$TOKEN_REQUEST_BODY")

echo "TOKEN ENDPOINT RAW RESPONSE:"
echo "$TOKEN_RESPONSE" | jq . 2>/dev/null || echo "$TOKEN_RESPONSE"
echo ""

# Extract access token
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token' 2>/dev/null)
if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
  echo "❌ ERROR: No access_token in response"
  echo "Full response: $TOKEN_RESPONSE"
  exit 1
fi

echo "✅ Token exchange succeeded"
echo "Access token (first 50 chars): ${ACCESS_TOKEN:0:50}..."
echo ""
sleep 1

# ================================================================
# STEP 3: AUTHORIZED RETRY WITH BEARER TOKEN  
# ================================================================
echo "STEP 3: Authorized retry with Bearer token"
echo "==========================================="
echo ""

CURL_CMD_3="curl -i -H 'Authorization: Bearer <access_token>' $DERIVED_RESOURCE"
echo "CURL COMMAND:"
echo "$CURL_CMD_3"
echo ""

AUTHORIZED_RESPONSE=$(curl -s -i -H "Authorization: Bearer $ACCESS_TOKEN" "$DERIVED_RESOURCE")

echo "RAW RESPONSE HEADERS & BODY:"
echo "$AUTHORIZED_RESPONSE"
echo ""

FINAL_STATUS=$(echo "$AUTHORIZED_RESPONSE" | head -1)
echo "Final status: $FINAL_STATUS"
echo ""

# ================================================================
# VERDICT
# ================================================================
echo "=========================================="
echo "TEST RESULT"
echo "=========================================="
echo ""

if echo "$FINAL_STATUS" | grep -q "200"; then
  echo "✅ SUCCESS: $FINAL_STATUS"
  echo ""
  echo "Policy-authorized derived resource read works!"
  echo ""
  echo "Full flow verified:"
  echo "  1. ✅ STEP 0: Policy created"
  echo "  2. ✅ STEP 1: Got UMA challenge (401)"
  echo "  3. ✅ STEP 2: Token exchange succeeded (200)"
  echo "  4. ✅ STEP 3: Authorized resource access succeeded (200)"
  exit 0
else
  echo "❌ FAILED: $FINAL_STATUS"
  echo ""
  echo "Expected: 200 OK"
  echo "Got: $FINAL_STATUS"
  exit 1
fi
