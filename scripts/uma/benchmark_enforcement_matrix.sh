#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${PANDA_UMA_OUT_DIR:-$PWD/benchmark-results/uma-proof-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/results.log"

RESOURCE="${PANDA_UMA_RESOURCE:-http://localhost:3000/alice/derived/acc-x/}"
WRONG_TARGET="${PANDA_UMA_WRONG_TARGET_RESOURCE:-http://localhost:3000/alice/derived/acc-y/}"
POLICY_ENDPOINT="${PANDA_UMA_POLICY_ENDPOINT:-http://localhost:4000/uma/policies}"
TOKEN_ENDPOINT="${PANDA_UMA_TOKEN_ENDPOINT:-http://localhost:4000/uma/token}"
SOURCE_SEED_ENDPOINT="${PANDA_UMA_SOURCE_SEED_ENDPOINT:-http://localhost:3000/alice/acc-x/}"
ALICE_WEBID="${PANDA_UMA_ALICE_WEBID:-http://localhost:3000/alice/profile/card#me}"
ALLOW_WEBID="${PANDA_UMA_ALLOW_WEBID:-http://localhost:3000/bob/profile/card#me}"
DENY_WEBID="${PANDA_UMA_DENY_WEBID:-http://localhost:3000/demo/profile/card#me}"
CLAIM_TOKEN_FORMAT="${PANDA_UMA_CLAIM_TOKEN_FORMAT:-urn:solidlab:uma:claims:formats:webid}"
AUTHZ_HEADER="Authorization: WebID $(node -e "console.log(encodeURIComponent('$ALICE_WEBID'))")"

log() {
  printf "%s\n" "$1" | tee -a "$LOG"
}

extract_ticket() {
  sed -n 's/.*ticket="\([^"]*\)".*/\1/p' | head -n1
}

encoded() {
  node -e "console.log(encodeURIComponent(process.argv[1]))" "$1"
}

request_ticket_body() {
  local ticket="$1"
  local webid="$2"
  jq -n \
    --arg t "$ticket" \
    --arg c "$(encoded "$webid")" \
    --arg f "$CLAIM_TOKEN_FORMAT" \
    '{grant_type:"urn:ietf:params:oauth:grant-type:uma-ticket",ticket:$t,claim_token:$c,claim_token_format:$f}'
}

write_policy_files() {
  cat > "$OUT_DIR/simple_allow.ttl" <<EOF
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <http://example.org/>
ex:p1 a odrl:Agreement ; odrl:uid ex:p1 ; odrl:permission ex:perm1 .
ex:perm1 a odrl:Permission ;
  odrl:target <$RESOURCE> ;
  odrl:assigner <$ALICE_WEBID> ;
  odrl:assignee <$ALLOW_WEBID> ;
  odrl:action odrl:read .
EOF

  cat > "$OUT_DIR/moderate_constrained.ttl" <<EOF
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <http://example.org/>
ex:p2 a odrl:Agreement ; odrl:uid ex:p2 ; odrl:permission ex:perm2 .
ex:perm2 a odrl:Permission ;
  odrl:target <$RESOURCE> ;
  odrl:assigner <$ALICE_WEBID> ;
  odrl:assignee <$ALLOW_WEBID> ;
  odrl:action odrl:read ;
  odrl:constraint [ a odrl:Constraint ; odrl:leftOperand odrl:purpose ; odrl:operator odrl:eq ; odrl:rightOperand <urn:client:benchmark> ] .
EOF

  cat > "$OUT_DIR/complex_constrained.ttl" <<EOF
PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <http://example.org/>
ex:p3 a odrl:Agreement ; odrl:uid ex:p3 ; odrl:permission ex:perm3, ex:perm4 .
ex:perm3 a odrl:Permission ;
  odrl:target <$RESOURCE> ;
  odrl:assigner <$ALICE_WEBID> ;
  odrl:assignee <$ALLOW_WEBID> ;
  odrl:action odrl:read ;
  odrl:constraint [ a odrl:Constraint ; odrl:leftOperand odrl:purpose ; odrl:operator odrl:eq ; odrl:rightOperand <urn:client:benchmark-complex> ] .
ex:perm4 a odrl:Permission ;
  odrl:target <$WRONG_TARGET> ;
  odrl:assigner <$ALICE_WEBID> ;
  odrl:assignee <$DENY_WEBID> ;
  odrl:action odrl:read .
EOF
}

post_policy() {
  local file="$1"
  curl -sS -i -X POST "$POLICY_ENDPOINT" \
    -H "$AUTHZ_HEADER" \
    -H "Content-Type: text/turtle" \
    --data-binary "@$file"
}

main() {
  log "out_dir=$OUT_DIR"
  curl -sS -o /dev/null -w "css:%{http_code}\n" http://localhost:3000/ | tee -a "$LOG"
  curl -sS -o /dev/null -w "uma:%{http_code}\n" http://localhost:4000/uma/.well-known/uma2-configuration | tee -a "$LOG"

  write_policy_files
  for p in simple_allow.ttl moderate_constrained.ttl complex_constrained.ttl; do
    post_policy "$OUT_DIR/$p" | tee "$OUT_DIR/policy_${p}.http.txt" >/dev/null
    log "policy_loaded:$p:$(head -n1 "$OUT_DIR/policy_${p}.http.txt")"
  done

  # Seed source so derived endpoint resolves content deterministically.
  SEED_STATUS="$(
    curl -sS -o /dev/null -w "%{http_code}" -X POST "$SOURCE_SEED_ENDPOINT" \
      -H "Content-Type: text/turtle" \
      -d "<http://example.org/obs-$(date +%s)> <http://purl.org/dc/terms/issued> \"2026-04-17T16:00:00Z\"^^<http://www.w3.org/2001/XMLSchema#dateTime> ."
  )"
  log "seed_status:$SEED_STATUS"

  # 1) Missing token on protected target -> 401 UMA challenge
  curl -sS -i "$RESOURCE" | tee "$OUT_DIR/test1_missing_token.http.txt" >/dev/null
  log "test1_status:$(head -n1 "$OUT_DIR/test1_missing_token.http.txt")"
  log "test1_www:$(grep -i '^WWW-Authenticate:' "$OUT_DIR/test1_missing_token.http.txt" | head -n1 || true)"
  TICKET_1="$(cat "$OUT_DIR/test1_missing_token.http.txt" | extract_ticket)"

  # 2) Valid token on correct target -> success
  BODY_2="$(request_ticket_body "$TICKET_1" "$ALLOW_WEBID")"
  curl -sS -i -X POST "$TOKEN_ENDPOINT" -H "Content-Type: application/json" -d "$BODY_2" \
    | tee "$OUT_DIR/test2_exchange_allow.http.txt" >/dev/null
  log "test2_token_status:$(head -n1 "$OUT_DIR/test2_exchange_allow.http.txt")"
  ACCESS_TOKEN="$(awk 'f{print} /^\r?$/{f=1}' "$OUT_DIR/test2_exchange_allow.http.txt" | jq -r '.access_token // empty')"
  TOKEN_TYPE="$(awk 'f{print} /^\r?$/{f=1}' "$OUT_DIR/test2_exchange_allow.http.txt" | jq -r '.token_type // "Bearer"')"
  curl -sS -i -H "Authorization: $TOKEN_TYPE $ACCESS_TOKEN" "$RESOURCE" \
    | tee "$OUT_DIR/test2_authorized_ok.http.txt" >/dev/null
  log "test2_resource_status:$(head -n1 "$OUT_DIR/test2_authorized_ok.http.txt")"

  # 3) Valid token on wrong target -> fail
  curl -sS -i -H "Authorization: $TOKEN_TYPE $ACCESS_TOKEN" "$WRONG_TARGET" \
    | tee "$OUT_DIR/test3_wrong_target.http.txt" >/dev/null
  log "test3_status:$(head -n1 "$OUT_DIR/test3_wrong_target.http.txt")"

  # 4) Invalid claim token -> fail exchange
  TICKET_4="$(curl -sS -i "$RESOURCE" | tee "$OUT_DIR/test4_challenge.http.txt" | extract_ticket)"
  BODY_4="$(jq -n --arg t "$TICKET_4" --arg c "not-a-webid" --arg f "$CLAIM_TOKEN_FORMAT" \
    '{grant_type:"urn:ietf:params:oauth:grant-type:uma-ticket",ticket:$t,claim_token:$c,claim_token_format:$f}')"
  curl -sS -i -X POST "$TOKEN_ENDPOINT" -H "Content-Type: application/json" -d "$BODY_4" \
    | tee "$OUT_DIR/test4_invalid_claim.http.txt" >/dev/null
  log "test4_status:$(head -n1 "$OUT_DIR/test4_invalid_claim.http.txt")"

  # 5) Reuse behavior on same target
  curl -sS -i -H "Authorization: $TOKEN_TYPE $ACCESS_TOKEN" "$RESOURCE" \
    | tee "$OUT_DIR/test5_reuse.http.txt" >/dev/null
  log "test5_status:$(head -n1 "$OUT_DIR/test5_reuse.http.txt")"

  # 6) Denial coverage: wrong requester
  TICKET_6="$(curl -sS -i "$RESOURCE" | tee "$OUT_DIR/test6_challenge.http.txt" | extract_ticket)"
  BODY_6="$(request_ticket_body "$TICKET_6" "$DENY_WEBID")"
  curl -sS -i -X POST "$TOKEN_ENDPOINT" -H "Content-Type: application/json" -d "$BODY_6" \
    | tee "$OUT_DIR/test6_wrong_requester.http.txt" >/dev/null
  log "test6_wrong_requester_status:$(head -n1 "$OUT_DIR/test6_wrong_requester.http.txt")"

  log "done"
}

main "$@"
