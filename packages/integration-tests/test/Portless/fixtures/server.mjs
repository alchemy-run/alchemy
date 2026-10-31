// A dev server for the Portless tests: answers every request with what it was started with.
import * as http from "node:http";

const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      name: process.env.SERVER_NAME ?? "",
      pid: process.pid,
      port,
      host: process.env.HOST,
      portlessUrl: process.env.PORTLESS_URL,
      stateDirectory: process.env.PORTLESS_STATE_DIR,
      extraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
      corsOrigin: process.env.CORS_ORIGIN,
      apiUrl: process.env.API_URL,
      requestHost: request.headers.host,
    }),
  );
});
server.listen(port, process.env.HOST ?? "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
