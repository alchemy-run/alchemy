// @ts-ignore — Suppress type errors if the module isn't found during editing/linting
import nitroApp from "../.output/server/index.mjs";

import { env } from "cloudflare:workers";

env;

export default {
  // Updated signature to include Env and ExecutionContext
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    return nitroApp.fetch(request, env, ctx);
  },
};
