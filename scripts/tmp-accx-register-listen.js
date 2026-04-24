const { client } = require('websocket');

const outputName = process.env.OUTPUT_NAME || 'output';
const query = `PREFIX saref: <https://saref.etsi.org/core/>
PREFIX : <https://rsp.js/>

REGISTER RStream <${outputName}> AS
SELECT ?s ?value
FROM NAMED WINDOW :w1 ON STREAM <http://localhost:3000/alice/acc-x/> [RANGE 5000 STEP 1000]
WHERE {
  WINDOW :w1 {
    ?s saref:hasValue ?value .
    ?s saref:relatesToProperty <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/wearable.acceleration.x> .
  }
}`;

const rules = `@prefix saref: <https://saref.etsi.org/core/>.
@prefix ex: <http://example.org/>.

{ ?s saref:hasValue ?value . } => { ?s ex:processed \"ACC_X_OBSERVATION\". }.`;

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
    } else {
      console.log(`[CLIENT][${new Date().toISOString()}] message_type=${message.type}`);
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
