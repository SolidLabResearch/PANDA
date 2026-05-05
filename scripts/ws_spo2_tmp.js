const WebSocketClient = require('websocket').client;
const c = new WebSocketClient();

const query = `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>
REGISTER RStream <output> AS
SELECT ((?o) AS ?avg)
FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/spo2/> [RANGE 60000 STEP 30000]
WHERE {
  WINDOW :w1 {
    ?s saref:hasValue ?o .
  }
}`;

c.on('connect', (conn) => {
  console.log('connected');

  conn.on('message', (message) => {
    if (message.type === 'utf8') {
      console.log('server message:', message.utf8Data);
    }
  });

  conn.on('close', (code, desc) => {
    console.log('closed', code, desc);
  });

  conn.on('error', (err) => {
    console.error('socket error:', err);
  });

  conn.sendUTF(JSON.stringify({
    query,
    rules: `@prefix saref: <https://saref.etsi.org/core/> .
@prefix math: <http://www.w3.org/2000/10/swap/math#> .
@prefix ex: <http://example.org/> .

{ ?s saref:hasValue ?spo2Value . ?spo2Value math:lessThan 90. } => { ?s ex:alert "SPO2_LOW". }.
`,
    type: 'live',
    actor_webid: 'http://localhost:3000/alice/profile/card#me'
  }));
});

c.on('connectFailed', (e) => {
  console.error(String(e));
  process.exit(1);
});

c.connect('ws://localhost:8080/', 'solid-stream-aggregator-protocol');
