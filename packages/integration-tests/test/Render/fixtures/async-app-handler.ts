import type { AsyncWebServiceEnv } from "./async-app.ts";

export default {
  async fetch(_request: Request, env: AsyncWebServiceEnv): Promise<Response> {
    return Response.json({ ok: true, mode: "async", greeting: env.GREETING });
  },
};
