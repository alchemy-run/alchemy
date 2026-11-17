import type { AsyncEmbedEnv } from "./async-function.ts";

const env = process.env as unknown as AsyncEmbedEnv;

Bun.serve({
  port: Number(process.env.PORT),
  hostname: "0.0.0.0",
  async fetch(request) {
    const { args, kwargs } = (await request.json()) as {
      args: [string];
      kwargs: Record<string, unknown>;
    };
    return Response.json({ greeting: env.GREETING, echo: args[0], kwargs });
  },
});
