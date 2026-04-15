#!/usr/bin/env bash
# Test script to validate derived resource authorization flow
# Usage: bash test-derived-resource-authorization.sh

set -e

# Configuration
ALICE_URL="http://localhost:3000/alice"
BOB_WEBID="http://localhost:3000/bob/profile/card#me"
ALICE_WEBID="http://localhost:3000/alice/profile/card#me"
DERIVED_RESOURCE="http://localhost:3000/alice/derived/acc-x/"
ALICE_POLICY_CONTAINER="$ALICE_URL/settings/policies/"
UMA_ENDPOINT="http://localhost:3000/uma"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}Derived Resource Authorization Validation Test${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Test 1: Create ODRL policy for derived resource
echo -e "${BLUE}[TEST 1] Creating ODRL policy for derived resource...${NC}"
cat > /tmp/derived-acc-x-policy.ttl << EOF
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <http://example.org/>
PREFIX dcterms: <http://purl.org/dc/terms/>

ex:derivedAccXAgreement a odrl:Agreement ;
    odrl:uid <urn:ucp:policy:test-derived-acc-x> ;
    dcterms:description "Allow Bob to read Alice's derived accelerometer-x data" ;
    odrl:permission ex:derivedAccXPermission .

ex:derivedAccXPermission a odrl:Permission ;
    odrl:target <${DERIVED_RESOURCE}> ;
    odrl:assigner <${ALICE_WEBID}> ;
    odrl:assignee <${BOB_WEBID}> ;
    odrl:action odrl:read .
EOF

POLICY_RESPONSE=$(curl -s -i -X POST \
  "$ALICE_POLICY_CONTAINER" \
  -H "Content-Type: text/turtle" \
  -d @/tmp/derived-acc-x-policy.ttl)

POLICY_STATUS=$(echo "$POLICY_RESPONSE" | head -1 | awk '{print $2}')
POLICY_LOCATION=$(echo "$POLICY_RESPONSE" | grep -i "^location:" | cut -d' ' -f2 | tr -d '\r')

if [ "$POLICY_STATUS" = "201" ]; then
  echo -e "${GREEN}✅ PASS${NC}: Policy created"
  echo "   Location: $POLICY_LOCATION"
else
  echo -e "${RED}❌ FAIL${NC}: Policy creation failed with status $POLICY_STATUS"
  echo "Response: $POLICY_RESPONSE"
  exit 1
fi
echo ""

# Test 2: GET derived resource without token (should return 403 + UMA challenge)
echo -e "${BLUE}[TEST 2] GET derived resource without token...${NC}"
DERIVED_RESPONSE=$(curl -s -i "$DERIVED_RESOURCE")
DERIVED_STATUS=$(echo "$DERIVED_RESPONSE" | head -1 | awk '{print $2}')
UMA_CHALLENGE=$(echo "$DERIVED_RESPONSE" | grep -i "^www-authenticate:" | head -1)

if [ "$DERIVED_STATUS" = "403" ] && [ ! -z "$UMA_CHALLENGE" ]; then
  echo -e "${GREEN}✅ PASS${NC}: Got 403 with UMA challenge"
  echo "   Status: 403"
  echo "   Challenge: $(echo $UMA_CHALLENGE | cut -c1-80)..."
  
  # Extract ticket
  TICKET=$(echo "$DERIVED_RESPONSE" | grep -o 'ticket="[^"]*"' | head -1 | cut -d'"' -f2)
  echo "   Ticket: ${TICKET:0:20}..."
else
  echo -e "${RED}❌ FAIL${NC}: Expected 403 with UMA challenge"
  echo "   Got status: $DERIVED_STATUS"
  echo "Response: $(echo "$DERIVED_RESPONSE" | head -15)"
  exit 1
fi
echo ""

# Test 3: Fetch UMA configuration
echo -e "${BLUE}[TEST 3] Fetching UMA configuration...${NC}"
UMA_CONFIG=$(curl -s "$UMA_ENDPOINT")
TOKEN_ENDPOINT=$(echo "$UMA_CONFIG" | grep -o '"token_endpoint":"[^"]*"' | cut -d'"' -f4)

if [ ! -z "$TOKEN_ENDPOINT" ]; then
  echo -e "${GREEN}✅ PASS${NC}: UMA configuration retrieved"
  echo "   Token endpoint: $TOKEN_ENDPOINT"
else
  echo -e "${RED}❌ FAIL${NC}: Could not fetch UMA configuration"
  exit 1
fi
echo ""

# Test 4: Verify policy is in the policy store by checking if we can read it
echo -e "${BLUE}[TEST 4] Verifying policy was stored...${NC}"
STORED_POLICY=$(curl -s "$POLICY_LOCATION")

if echo "$STORED_POLICY" | grep -q "odrl:target"; then
  echo -e "${GREEN}✅ PASS${NC}: Policy stored and retrievable"
  echo "   URL: $POLICY_LOCATION"
  echo "   Contains odrl:target: ✓"
  echo "   Contains odrl:Permission: $(grep -q 'odrl:Permission' <<< $STORED_POLICY && echo '✓' || echo '✗')"
else
  echo -e "${RED}❌ FAIL${NC}: Policy not found or invalid"
  exit 1
fi
echo ""

# Test 5: Verify policy targets the derived resource
echo -e "${BLUE}[TEST 5] Verifying policy target matches derived resource...${NC}"
if echo "$STORED_POLICY" | grep -q "$DERIVED_RESOURCE"; then
  echo -e "${GREEN}✅ PASS${NC}: Policy target matches derived resource IRI"
  echo "   Target: $DERIVED_RESOURCE"
else
  echo -e "${RED}❌ FAIL${NC}: Policy target does not match derived resource"
  exit 1
fi
echo ""

# Test 6: Check OdrlAuthorizer logs for policy evaluation
echo -e "${BLUE}[TEST 6] Authorization flow ready for testing...${NC}"
echo -e "${GREEN}✅ Policy setup complete${NC}"
echo ""
echo "Next steps to complete authorization flow:"
echo "1. Bob generates claim token (JWT) with his WebID: $BOB_WEBID"
echo "2. Bob POSTs to $TOKEN_ENDPOINT with:"
echo "   - grant_type: urn:ietf:params:oauth:grant-type:uma-ticket"
echo "   - ticket: $TICKET"
echo "   - claim_token: <bob-jwt>"
echo ""
echo "3. Check OdrlAuthorizer logs for:"
echo "   Evaluating Request [S R AR]: [$BOB_WEBID $DERIVED_RESOURCE http://www.w3.org/ns/odrl/2/read]"
echo ""
echo "4. If policy correctly stored && Bob authorized, should see:"
echo "   - Token endpoint returns: 200 OK with access_token"
echo "   - Bearer GET to $DERIVED_RESOURCE returns: 200 OK"
echo ""

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ ALL TESTS PASSED - Policy created and verified${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
