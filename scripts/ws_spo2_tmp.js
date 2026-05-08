const WebSocketClient = require('websocket').client;
const util = require('util');
const c = new WebSocketClient();

function describeError(error) {
  if (!error) {
    return 'unknown error';
  }
  const payload = {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: error.stack,
  };
  if (Array.isArray(error.errors)) {
    payload.errors = error.errors.map((child) => ({
      name: child?.name,
      message: child?.message,
      code: child?.code,
      errno: child?.errno,
      syscall: child?.syscall,
      address: child?.address,
      port: child?.port,
      stack: child?.stack,
    }));
  }
  return util.inspect(payload, { depth: 6, colors: false });
}

const query = `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>
REGISTER RStream <output> AS
SELECT (AVG(?o) AS ?avg)
FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/spo2/> [RANGE 30000 STEP 30000]
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
  console.error(describeError(e));
  process.exit(1);
});

c.connect('ws://localhost:8080/', 'solid-stream-aggregator-protocol');
