import type { AsyncApiEnv } from "./async-server.ts";

const env = process.env as unknown as AsyncApiEnv;

Bun.serve({
  port: Number(process.env.PORT),
  hostname: "0.0.0.0",
  fetch: () => Response.json({ kind: "async-server", greeting: env.GREETING }),
});
