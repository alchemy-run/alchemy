import type { WebEnv } from "./resources.ts";

export default {
  async fetch(_request: Request, env: WebEnv) {
    return new Response(env.GREETING);
  },
};
