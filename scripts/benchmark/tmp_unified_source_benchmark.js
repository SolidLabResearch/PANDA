#!/usr/bin/env node
const fs = require('fs');
const { randomUUID } = require('crypto');
const { client: WebSocketClient } = require('websocket');

const SOURCE = 'http://localhost:3000/alice/acc-x/';
const WS_URL = 'ws://localhost:8080/';
const LOG_FILE = '/tmp/panda_unified_source.log';
const CLAIM = 'http://localhost:3000/bob/profile/card#me';
const CLAIM_FMT = 'urn:solidlab:uma:claims:formats:webid';
const OWNER_WEBID = 'http://localhost:3000/alice/profile/card#me';
const POLICY_ENDPOINT = 'http://localhost:4000/uma/policies';
const CONTAINS_RELATION = 'http://www.w3.org/ns/ldp#contains';
const DERIVED_SOURCE = 'http://localhost:3000/alice/derived/acc-x';
const DERIVED_SOURCE_SLASH = `${DERIVED_SOURCE}/`;
const ALERT_CONTAINER = 'http://localhost:3000/alice/derived/anomaly-alert/';
const ALERT_CONTAINER_NOSLASH = ALERT_CONTAINER.replace(/\/$/, '');
const RUNS = 5;
const RANGE_MS = 20000;
const TRIGGER_DELTA_MS = 1000;
const POLL_MS = 100;
const RUN_TIMEOUT_MS = 45000;

const query = `PREFIX saref: <https://saref.etsi.org/core/>\nPREFIX : <https://rsp.js/>\n\nREGISTER RStream <output_${Date.now()}> AS\nSELECT ?s ?spo2Value\nFROM NAMED WINDOW :w1 ON STREAM <${SOURCE}> [RANGE 20000 STEP 5000]\nWHERE {\n  WINDOW :w1 {\n    ?s saref:hasValue ?spo2Value .\n    ?s saref:relatesToProperty <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2> .\n  }\n}`;

const rules = `@prefix saref: <https://saref.etsi.org/core/>.
@prefix math: <http://www.w3.org/2000/10/swap/math#>.
@prefix ex: <http://example.org/>.

{ ?s saref:hasValue ?spo2Value . ?spo2Value math:lessThan 90. } => { ?s ex:alert "SPO2_LOW". }.`;

function formatClaimToken(claimToken, claimTokenFormat) {
  return claimTokenFormat === CLAIM_FMT ? encodeURIComponent(claimToken) : claimToken;
}

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function toMs(v){ const m=Date.parse(v); return Number.isNaN(m)?null:m; }
function stageLatency(stages,a,b){ const x=toMs(stages[a]); const y=toMs(stages[b]); return (x===null||y===null)?null:y-x; }
function median(vals){ if(!vals.length) return null; const s=[...vals].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function p95(vals){ if(!vals.length) return null; const s=[...vals].sort((a,b)=>a-b); return s[Math.max(0,Math.ceil(0.95*s.length)-1)]; }
function avg(vals){ if(!vals.length) return null; return vals.reduce((a,b)=>a+b,0)/vals.length; }

function parseWWW(header){
  if(!header || !/^UMA\s+/i.test(header)) return null;
  const parts = Object.fromEntries(header.replace(/^UMA\s+/i,'').split(/\s*,\s*/).map(p=>{
    const i=p.indexOf('=');
    if(i<0) return [p.trim(),''];
    return [p.slice(0,i).trim(), p.slice(i+1).trim().replace(/^"|"$/g,'')];
  }));
  if(!parts.ticket || !parts.as_uri) return null;
  const tokenEndpoint = new URL('token', parts.as_uri.endsWith('/')?parts.as_uri:parts.as_uri+'/').toString();
  return {ticket:parts.ticket, tokenEndpoint, as_uri:parts.as_uri};
}

async function exchangeToken(tokenEndpoint, ticket){
  const body = {
    grant_type:'urn:ietf:params:oauth:grant-type:uma-ticket',
    ticket,
    claim_token: formatClaimToken(CLAIM, CLAIM_FMT),
    claim_token_format: CLAIM_FMT,
  };
  const res = await fetch(tokenEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const txt = await res.text();
  let json={}; try{ json=JSON.parse(txt);}catch{}
  if(res.status!==200 || !json.access_token) throw new Error(`token_exchange_failed ${res.status} ${txt}`);
  return {tokenType: json.token_type||'Bearer', accessToken: json.access_token};
}

async function exchangeTokenForClaim(tokenEndpoint, ticket, claimWebId){
  const body = {
    grant_type:'urn:ietf:params:oauth:grant-type:uma-ticket',
    ticket,
    claim_token: formatClaimToken(claimWebId, CLAIM_FMT),
    claim_token_format: CLAIM_FMT,
  };
  const res = await fetch(tokenEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const txt = await res.text();
  let json={}; try{ json=JSON.parse(txt);}catch{}
  if(res.status!==200 || !json.access_token) throw new Error(`token_exchange_failed ${res.status} ${txt}`);
  return {tokenType: json.token_type||'Bearer', accessToken: json.access_token};
}

async function getTokenForClaim(resourceUrl, claimWebId, method = 'GET', body = undefined, contentType = undefined){
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  const probe = await fetch(resourceUrl, { method, headers, body });
  const parsed = parseWWW(probe.headers.get('WWW-Authenticate') || '');
  if (probe.status !== 401 || !parsed) {
    throw new Error(`challenge_failed resource=${resourceUrl} status=${probe.status}`);
  }
  return exchangeTokenForClaim(parsed.tokenEndpoint, parsed.ticket, claimWebId);
}

async function ensureSourceContainer(){
  const probe = await fetch(SOURCE);
  if (probe.status === 200) {
    return;
  }
  const parsed = parseWWW(probe.headers.get('WWW-Authenticate') || '');
  if (probe.status === 401 && parsed) {
    return;
  }
  const body = [
    '@prefix ldp: <http://www.w3.org/ns/ldp#> .',
    '<> a ldp:Container, ldp:BasicContainer .',
    ''
  ].join('\n');
  const res = await fetch(SOURCE, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body,
  });
  if (!(res.status === 200 || res.status === 201 || res.status === 409 || res.status === 401)) {
    throw new Error(`ensure_source_failed status=${res.status} body=${await res.text()}`);
  }
}

function buildSourcePolicyTurtle() {
  const ns = `http://example.org/panda/benchmark/${Date.now()}/${randomUUID()}#`;
  const collectionTarget = `collection:${SOURCE}:${CONTAINS_RELATION}`;
  const derivedCollectionTarget = `collection:${DERIVED_SOURCE_SLASH}:${CONTAINS_RELATION}`;
  return `PREFIX odrl: <http://www.w3.org/ns/odrl/2/>
PREFIX ex: <${ns}>

ex:policy a odrl:Agreement ;
  odrl:uid ex:policy ;
  odrl:permission ex:containerRead, ex:memberRead, ex:derivedRead, ex:derivedSlashRead, ex:derivedMemberRead, ex:alertWrite, ex:alertRead, ex:alertReadNoSlash .

ex:containerRead a odrl:Permission ;
  odrl:target <${SOURCE}> ;
  odrl:assigner <${OWNER_WEBID}> ;
  odrl:assignee <${CLAIM}> ;
  odrl:action odrl:read .

ex:memberRead a odrl:Permission ;
  odrl:target <${collectionTarget}> ;
  odrl:assigner <${OWNER_WEBID}> ;
  odrl:assignee <${CLAIM}> ;
  odrl:action odrl:read .

ex:derivedRead a odrl:Permission ;
  odrl:target <${DERIVED_SOURCE}> ;
  odrl:assigner <${OWNER_WEBID}> ;
  odrl:assignee <${CLAIM}> ;
  odrl:action odrl:read .

ex:derivedSlashRead a odrl:Permission ;
  odrl:target <${DERIVED_SOURCE_SLASH}> ;
  odrl:assigner <${OWNER_WEBID}> ;
  odrl:assignee <${CLAIM}> ;
  odrl:action odrl:read .

ex:derivedMemberRead a odrl:Permission ;
  odrl:target <${derivedCollectionTarget}> ;
  odrl:assigner <${OWNER_WEBID}> ;
  odrl:assignee <${CLAIM}> ;
  odrl:action odrl:read .

ex:alertWrite a odrl:Permission ;
  odrl:target <${ALERT_CONTAINER}> ;
  odrl:assigner <${OWNER_WEBID}> ;
  odrl:assignee <${CLAIM}> ;
  odrl:action odrl:write, odrl:append, odrl:create, odrl:modify .

ex:alertRead a odrl:Permission ;
  odrl:target <${ALERT_CONTAINER}> ;
  odrl:assigner <${OWNER_WEBID}> ;
  odrl:assignee <${CLAIM}> ;
  odrl:action odrl:read .

ex:alertReadNoSlash a odrl:Permission ;
  odrl:target <${ALERT_CONTAINER_NOSLASH}> ;
  odrl:assigner <${OWNER_WEBID}> ;
  odrl:assignee <${CLAIM}> ;
  odrl:action odrl:read .
`;
}

async function ensureSourcePolicies() {
  const body = buildSourcePolicyTurtle();
  const res = await fetch(POLICY_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `WebID ${encodeURIComponent(OWNER_WEBID)}`,
      'Content-Type': 'text/turtle',
    },
    body,
  });
  if (!(res.status === 200 || res.status === 201 || res.status === 409)) {
    throw new Error(`source_policy_bootstrap_failed ${res.status} ${await res.text()}`);
  }
}

async function measureGrantPath(){
  const stages={t6:null,t7:null,t8:null,t9:null,t10:null,t11:null};
  stages.t6 = new Date().toISOString();
  const ch = await fetch(SOURCE);
  stages.t7 = new Date().toISOString();
  const chStatus = ch.status;
  const www = ch.headers.get('WWW-Authenticate')||'';
  const parsed = parseWWW(www);
  if(chStatus!==401 || !parsed) throw new Error(`expected_401_uma_challenge got=${chStatus} www=${www}`);
  stages.t8 = new Date().toISOString();
  const tok = await exchangeToken(parsed.tokenEndpoint, parsed.ticket);
  stages.t9 = new Date().toISOString();
  stages.t10 = new Date().toISOString();
  const ok = await fetch(SOURCE,{headers:{Authorization:`${tok.tokenType} ${tok.accessToken}`}});
  stages.t11 = new Date().toISOString();
  if(ok.status!==200) throw new Error(`authorized_get_failed ${ok.status}`);
  await ok.text().catch(()=>{});
  return {
    stages,
    statuses:{challenge_status:chStatus, token_status:200, authorized_get_status:ok.status, www_authenticate:www},
    latencies:{
      challenge_latency:stageLatency(stages,'t6','t7'),
      token_exchange_latency:stageLatency(stages,'t8','t9'),
      protected_get_latency:stageLatency(stages,'t10','t11'),
      total_grant_path_latency:stageLatency(stages,'t6','t11'),
    },
    readToken: tok,
  };
}

async function getWriteToken(){
  const dummy = `<${SOURCE}ticket-probe-${Date.now()}> <http://example.org/p> "x" .\n`;
  const ch = await fetch(SOURCE,{method:'POST',headers:{'Content-Type':'text/turtle'},body:dummy});
  const www = ch.headers.get('WWW-Authenticate')||'';
  const parsed = parseWWW(www);
  if(ch.status!==401 || !parsed) throw new Error(`write_challenge_failed status=${ch.status} www=${www}`);
  return exchangeToken(parsed.tokenEndpoint, parsed.ticket);
}

async function registerWebhook(){
  const payload = {
    '@context':['https://www.w3.org/ns/solid/notification/v1'],
    type:'http://www.w3.org/ns/solid/notifications#WebhookChannel2023',
    topic: SOURCE,
    sendTo:'http://localhost:8080/',
  };
  let res = await fetch('http://localhost:3000/.notifications/WebhookChannel2023/',{
    method:'POST', headers:{'Content-Type':'application/ld+json'}, body: JSON.stringify(payload)
  });
  let body = await res.text().catch(()=> '');
  if (res.status === 401) {
    try {
      const parsed = parseWWW(res.headers.get('WWW-Authenticate') || '');
      if (!parsed) throw new Error(`webhook_register_failed 401 ${body}`);
      const aliceToken = await exchangeTokenForClaim(parsed.tokenEndpoint, parsed.ticket, 'http://localhost:3000/bob/profile/card#me');
      res = await fetch('http://localhost:3000/.notifications/WebhookChannel2023/',{
        method:'POST',
        headers:{
          'Content-Type':'application/ld+json',
          Authorization: `${aliceToken.tokenType} ${aliceToken.accessToken}`,
        },
        body: JSON.stringify(payload)
      });
      body = await res.text().catch(()=> '');
    } catch (error) {
      console.log(`[warn] webhook_register_auth_failed ${error.message}`);
      return;
    }
  }
  if(!(res.status===200||res.status===201)) {
    console.log(`[warn] webhook_register_failed status=${res.status} body=${body}`);
  }
}

async function registerQuery(){
  const c = new WebSocketClient();
  return new Promise((resolve,reject)=>{
    c.on('connectFailed', reject);
    c.on('connect',(conn)=>{
      conn.sendUTF(JSON.stringify({query, rules, type:'live'}));
      resolve(conn);
    });
    c.connect(WS_URL,'solid-stream-aggregator-protocol');
  });
}

function readNewLines(cursor){
  const st = fs.statSync(LOG_FILE);
  if(st.size===cursor) return {cursor, lines:[]};
  if(st.size<cursor) cursor=0;
  const fd = fs.openSync(LOG_FILE,'r');
  const len = st.size-cursor;
  const buf = Buffer.alloc(len);
  fs.readSync(fd,buf,0,len,cursor);
  fs.closeSync(fd);
  return {cursor:st.size, lines: buf.toString('utf8').split(/\r?\n/)};
}

function parseMeasure(line){
  const ts = (line.match(/timestamp=([^\s]+)/)||[])[1];
  const eventId = (line.match(/event_id=([^\s]+)/)||[])[1];
  const status = (line.match(/status=(\d{3})/)||[])[1];
  if(line.includes('[MEASURE][INGEST]') && ts) return {stage:'t1', ts, eventId};
  if(line.includes('[MEASURE][RSP] event_added') && ts) return {stage:'t2', ts, eventId};
  if(line.includes('[MEASURE][RULE] matched') && ts) return {stage:'t3', ts, eventId};
  if(line.includes('[MEASURE][ALERT] write_start') && ts) return {stage:'t4', ts, eventId};
  if(line.includes('[MEASURE][ALERT] write_success') && ts) return {stage:'t5', ts, eventId};
  if(line.includes('[VALIDATION][ALERT][WRITE_RESPONSE]') && eventId) return {stage:'write_response', eventId, status: status?Number(status):null};
  return null;
}

async function postEvent(eventId, value, timestampIso, writeToken){
  const ttl = `<${eventId}> <https://saref.etsi.org/core/hasValue> "${value}"^^<http://www.w3.org/2001/XMLSchema#decimal> .\n`
    + `<${eventId}> <https://saref.etsi.org/core/relatesToProperty> <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2> .\n`
    + `<${eventId}> <https://saref.etsi.org/core/hasTimestamp> "${timestampIso}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .\n`;
  const res = await fetch(SOURCE,{method:'POST',headers:{'Content-Type':'text/turtle', Authorization:`${writeToken.tokenType} ${writeToken.accessToken}`},body:ttl});
  const body = await res.text().catch(()=> '');
  if(!(res.status===200||res.status===201)) throw new Error(`post_event_failed ${res.status} ${body}`);
}

async function warmup(writeToken, readToken, cursor){
  const need = {
    latest_event_received_preprocessing_started:false,
    latest_event_added_to_rsp_engine:false,
    rule_matched:false,
  };
  for(let attempt=1; attempt<=6; attempt++){
    const t0ms=Date.now();
    const idA=`${SOURCE.replace(/\/$/,'')}/${randomUUID()}`;
    const idB=`${SOURCE.replace(/\/$/,'')}/${randomUUID()}`;
    const t0 = new Date(t0ms).toISOString();
    const tB = new Date(t0ms + RANGE_MS + TRIGGER_DELTA_MS).toISOString();
    await postEvent(idA,'81',t0,writeToken);
    await postEvent(idB,'95',tB,writeToken);
    await fetch(SOURCE,{headers:{Authorization:`${readToken.tokenType} ${readToken.accessToken}`}}).then(r=>r.text()).catch(()=>{});

    const deadline = Date.now()+25000;
    while(Date.now()<deadline){
      const out=readNewLines(cursor); cursor=out.cursor;
      for(const line of out.lines){
        if(
          line.includes('webhook_notification_received') ||
          line.includes('webhook_notification_emitting_topic') ||
          line.includes('Subscription to the LDES Stream')
        ) {
          need.webhook_notification_received=true;
        }
        if(line.includes('latest_event_received_preprocessing_started') || line.includes('[MEASURE][INGEST] event_received')) need.latest_event_received_preprocessing_started=true;
        if(line.includes('latest_event_added_to_rsp_engine') || line.includes('[MEASURE][RSP] event_added') || line.includes('event_added_to_rsp_engine')) need.latest_event_added_to_rsp_engine=true;
        if(line.includes('[MEASURE][RULE] matched')) need.rule_matched=true;
        if(
          line.includes('[MEASURE][ALERT] write_success') ||
          line.includes('[VALIDATION][ALERT][WRITE_RESPONSE] status=201')
        ) {
          need.write_success=true;
        }
      }
      if(Object.values(need).every(Boolean)) return {ok:true, cursor, markers:need, attempts:attempt};
      await wait(POLL_MS);
    }
  }
  return {ok:false, cursor, markers:need, attempts:6};
}

async function runMeasured(run, writeToken, readToken, cursor){
  const stages = {t0:null,t_fetch_start:null,t_fetch_end:null,t_parse_done:null,t1:null,t2:null,t3:null,t4:null,t5:null};
  const idA=`${SOURCE.replace(/\/$/,'')}/${randomUUID()}`;
  const idB=`${SOURCE.replace(/\/$/,'')}/${randomUUID()}`;
  const t0ms=Date.now();
  stages.t0 = new Date(t0ms).toISOString();
  const tB = new Date(t0ms + RANGE_MS + TRIGGER_DELTA_MS).toISOString();

  await postEvent(idA,'81',stages.t0,writeToken);
  await postEvent(idB,'95',tB,writeToken);

  stages.t_fetch_start = new Date().toISOString();
  const res = await fetch(SOURCE,{headers:{Authorization:`${readToken.tokenType} ${readToken.accessToken}`}});
  stages.t_fetch_end = new Date().toISOString();
  await res.text().catch(()=>{});
  stages.t_parse_done = new Date().toISOString();

  let write_status = null;
  const deadline = Date.now()+RUN_TIMEOUT_MS;
  while(Date.now()<deadline){
    const out=readNewLines(cursor); cursor=out.cursor;
    for(const line of out.lines){
      const p = parseMeasure(line);
      if(!p) continue;
      if(p.eventId !== idA) continue;
      if(p.stage==='write_response' && p.status!==null) write_status = p.status;
      if(['t1','t2','t3','t4','t5'].includes(p.stage) && !stages[p.stage]) stages[p.stage]=p.ts;
    }
    if(stages.t5 && write_status===201) break;
    await wait(POLL_MS);
  }

  const order = ['t0','t1','t2','t3','t4','t5'];
  let monotonic = true;
  for(let i=1;i<order.length;i++){
    const a=toMs(stages[order[i-1]]); const b=toMs(stages[order[i]]);
    if(a===null || b===null || !(a<b)) { monotonic=false; break; }
  }

  const latencies = {
    fetch_latency: stageLatency(stages,'t_fetch_start','t_fetch_end'),
    parsing_latency: stageLatency(stages,'t_fetch_end','t_parse_done'),
    ingestion_latency: stageLatency(stages,'t_parse_done','t1'),
    rsp_latency: stageLatency(stages,'t1','t2'),
    rule_latency: stageLatency(stages,'t2','t3'),
    write_latency: stageLatency(stages,'t4','t5'),
    total_event_to_alert_latency: stageLatency(stages,'t0','t5'),
  };

  const accepted = Object.values(stages).every(Boolean) && monotonic && write_status===201;
  return {run, event_id_A:idA, event_id_B:idB, stages, write_status, monotonic, accepted, latencies, cursor};
}

function summarize(rows, key){
  const vals = rows.map(r=>r.latencies[key]).filter(v=>v!==null && v!==undefined);
  return {avg:avg(vals), median:median(vals), p95:p95(vals)};
}

(async()=>{
  if(!fs.existsSync(LOG_FILE)) throw new Error(`missing_log ${LOG_FILE}`);
  await ensureSourceContainer();
  await ensureSourcePolicies();
  const control = await measureGrantPath();
  await registerWebhook();
  const ws = await registerQuery();
  await wait(1200);

  let cursor = fs.statSync(LOG_FILE).size;
  const writeToken = await getWriteToken();
  const readToken = control.readToken;

  const warm = await warmup(writeToken, readToken, cursor);
  cursor = warm.cursor;
  if(!warm.ok) throw new Error(`warmup_markers_missing ${JSON.stringify(warm.markers)}`);

  const rows=[];
  for(let i=1;i<=RUNS;i++){
    const row = await runMeasured(i, writeToken, readToken, cursor);
    cursor = row.cursor;
    delete row.cursor;
    rows.push(row);
  }

  ws.close();

  const acceptedRows = rows.filter(r=>r.accepted);
  const metrics = {
    fetch_latency: summarize(acceptedRows,'fetch_latency'),
    parsing_latency: summarize(acceptedRows,'parsing_latency'),
    ingestion_latency: summarize(acceptedRows,'ingestion_latency'),
    rsp_latency: summarize(acceptedRows,'rsp_latency'),
    rule_latency: summarize(acceptedRows,'rule_latency'),
    write_latency: summarize(acceptedRows,'write_latency'),
    total_event_to_alert_latency: summarize(acceptedRows,'total_event_to_alert_latency'),
  };

  const dominant = Object.entries({
    ingestion_latency: metrics.ingestion_latency.avg,
    rsp_latency: metrics.rsp_latency.avg,
    rule_latency: metrics.rule_latency.avg,
    write_latency: metrics.write_latency.avg,
  }).filter(([,v])=>v!==null).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;

  const out = {
    status: acceptedRows.length===RUNS ? 'ok' : 'partial',
    source: SOURCE,
    control_plane: {
      stages: control.stages,
      statuses: control.statuses,
      latencies: control.latencies,
    },
    warmup: {attempts: warm.attempts, markers: warm.markers},
    runs: rows,
    accepted_runs: acceptedRows.length,
    metrics,
    dominant_stage: dominant,
  };
  console.log(JSON.stringify(out,null,2));
})().catch((e)=>{
  const details = e && typeof e === 'object'
    ? { message: e.message || '', stack: e.stack || '', name: e.name || '', raw: String(e) }
    : { raw: String(e) };
  console.error(JSON.stringify({ status:'failed', error: details.message || details.raw || '', details }, null, 2));
  process.exit(1);
});
