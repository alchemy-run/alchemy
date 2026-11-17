import type { HelloEnv } from "./resources.ts";

export default {
  async fetch(request: Request, env: HelloEnv) {
    const url = new URL(request.url);
    return Response.json({ greeting: env.GREETING, path: url.pathname });
  },
};
