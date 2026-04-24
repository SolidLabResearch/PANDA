const { client } = require('websocket');

const query = `PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>
REGISTER RStream <output> AS
SELECT (AVG(?o) AS ?avgValue)
FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/acc-x/> [RANGE 20000 STEP 5000]
WHERE {
  WINDOW :w1 {
    ?s saref:hasValue ?o .
  }
}`;

const c = new client();
c.on('connectFailed', (err) => {
  console.error(err);
  process.exit(1);
});

c.on('connect', (conn) => {
  conn.sendUTF(JSON.stringify({ query, rules: '', type: 'live' }));
  setTimeout(() => conn.close(), 8000);
});

c.connect('ws://localhost:8080/', 'solid-stream-aggregator-protocol');
setTimeout(() => process.exit(0), 9000);
