// Fixture for the dev-ingress test: a real HTTP server on `PORT` that echoes
// what it sees of each request, and prints its own URL the way a framework
// dev server would so `Command.Dev` extracts it.
const http = require("node:http");

const port = Number(process.env.PORT ?? 0);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      path: req.url,
      host: req.headers.host ?? null,
      forwardedHost: req.headers["x-forwarded-host"] ?? null,
      forwardedProto: req.headers["x-forwarded-proto"] ?? null,
    }),
  );
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`Local: http://localhost:${address.port}/\n`);
});
