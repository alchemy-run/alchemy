// A dev server for the Portless tests: answers every request with what it was started with.
import * as http from "node:http";
import * as https from "node:https";

const port = Number(process.env.PORT);
// GET /call: this server calls API_URL over HTTPS, trusting what its environment gives it and
// nothing else. The request goes to the proxy on 127.0.0.1 and names the host in SNI and `Host`,
// so it doesn't depend on how this machine resolves `.localhost`.
const call = (response) => {
  const url = new URL(process.env.API_URL ?? "");
  const outgoing = https.request(
    {
      host: "127.0.0.1",
      port: url.port,
      path: "/",
      servername: url.hostname,
      agent: false,
      headers: { host: url.host, connection: "close" },
    },
    (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () =>
        response.end(
          JSON.stringify({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }),
        ),
      );
    },
  );
  outgoing.once("error", (error) => response.end(JSON.stringify({ error: error.message })));
  outgoing.end();
};

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/call") return call(response);
  response.end(
    JSON.stringify({
      name: process.env.SERVER_NAME ?? "",
      pid: process.pid,
      port,
      host: process.env.HOST,
      portlessUrl: process.env.PORTLESS_URL,
      stateDirectory: process.env.PORTLESS_STATE_DIR,
      extraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
      devTrust: process.env.ALCHEMY_DEV_TRUST,
      corsOrigin: process.env.CORS_ORIGIN,
      apiUrl: process.env.API_URL,
      requestHost: request.headers.host,
    }),
  );
});
server.listen(port, process.env.HOST ?? "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
