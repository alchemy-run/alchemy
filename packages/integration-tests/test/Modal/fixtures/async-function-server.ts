import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import type { AsyncEmbedEnv } from "./async-function.ts";

const env = process.env as unknown as AsyncEmbedEnv;

createServer(async (request, response) => {
  const { args, kwargs } = JSON.parse(await text(request)) as {
    args: [string];
    kwargs: Record<string, unknown>;
  };
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ greeting: env.GREETING, echo: args[0], kwargs }));
}).listen(Number(process.env.PORT), "0.0.0.0");
