const { client } = require('websocket');

const query = `PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>

REGISTER RStream <output_unique_20260421> AS
SELECT ?s ?spo2Value
FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/spo2/> [RANGE 6300 STEP 1701]
WHERE {
  WINDOW :w1 {
    ?s saref:hasValue ?spo2Value .
    ?s saref:relatesToProperty <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.spo2> .
  }
}`;

const rules = `@prefix saref: <https://saref.etsi.org/core/>.
@prefix math: <http://www.w3.org/2000/10/swap/math#>.
@prefix ex: <http://example.org/>.

{ ?s saref:hasValue ?spo2Value . ?spo2Value math:lessThan 90. } => { ?s ex:alert "SPO2_LOW". }.`;

const c = new client();
c.on('connectFailed', (err) => {
  console.error(`[CLIENT][${new Date().toISOString()}] connect_failed ${err.message}`);
  process.exit(1);
});

c.on('connect', (conn) => {
  console.log(`[CLIENT][${new Date().toISOString()}] connected`);
  conn.on('message', (message) => {
    if (message.type === 'utf8') {
      console.log(`[CLIENT][${new Date().toISOString()}] message_utf8=${message.utf8Data}`);
    }
  });

  conn.sendUTF(JSON.stringify({ query, rules, type: 'live' }));
  console.log(`[CLIENT][${new Date().toISOString()}] query_sent`);

  setTimeout(() => {
    conn.close();
    process.exit(0);
  }, 30000);
});

c.connect('ws://localhost:8080/', 'solid-stream-aggregator-protocol');
