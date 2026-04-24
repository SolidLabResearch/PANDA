const WebSocketClient = require('websocket').client;
const client = new WebSocketClient();
const query = `PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>

REGISTER RStream <output> AS
SELECT (AVG(?o) AS ?avgValue)
FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/acc-x/> [RANGE 20000 STEP 5000]
WHERE {
  WINDOW :w1 {
    ?s saref:hasValue ?o .
  }
}
`;
client.on('connect', (conn) => {
  console.log('connected');
  conn.sendUTF(JSON.stringify({query, rules: [], type: 'live', actor_webid: 'http://localhost:3000/alice/profile/card#me'}));
  conn.on('message', (m) => console.log('message', m.utf8Data || m.type));
  setInterval(() => {}, 1000);
});
client.on('connectFailed', (e) => { console.error('connectFailed', String(e)); process.exit(1); });
client.connect('ws://localhost:8080/', 'solid-stream-aggregator-protocol');
