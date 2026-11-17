import { createServer } from "node:http";
import type { AsyncAgentEnv } from "./async-agent.ts";

const env = process.env as unknown as AsyncAgentEnv;

createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ agent: "async", greeting: env.GREETING }));
}).listen(Number(process.env.PORT), "0.0.0.0");
