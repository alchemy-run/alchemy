import type { PingEnv } from "./stack.ts";

/**
 * The async form: no Effect in the bundle. `env` is `process.env`, typed from the
 * Function's `env` prop.
 */
export default {
  async fetch(request: Request, env: PingEnv) {
    return Response.json({
      form: "async",
      greeting: env.GREETING,
      path: new URL(request.url).pathname,
    });
  },
};
