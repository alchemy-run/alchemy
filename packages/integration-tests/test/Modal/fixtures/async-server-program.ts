import { createServer } from "node:http";
import type { AsyncApiEnv } from "./async-server.ts";

const env = process.env as unknown as AsyncApiEnv;

createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ kind: "async-server", greeting: env.GREETING }));
}).listen(Number(process.env.PORT), "0.0.0.0");
