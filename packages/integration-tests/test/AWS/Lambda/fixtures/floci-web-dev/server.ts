/**
 * Hot-reload fixture for the floci Web Function dev provider test
 * ([WebFunction.local.test.ts](../../WebFunction.local.test.ts)). The test
 * clones this directory and rewrites `MARKER` in the CLONE, so the
 * checked-in value is always `marker-v1`.
 */
import * as http from "node:http";

const MARKER = "marker-v1";

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${MARKER}:${process.env.GREETING ?? ""}`);
  })
  .listen(Number(port), host);
