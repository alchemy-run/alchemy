// @ts-ignore — Suppress type errors if the module isn't found during editing/linting
import nitroApp from "../.output/server/index.mjs";

export default {
  // Updated signature to include Env and ExecutionContext
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    // Otherwise, assume it's a static asset request handled by the ASSETS binding
    const response = await env.ASSETS.fetch(request);

    if (response.status === 404) {
      // SSR
      return nitroApp.fetch(request, env, ctx);
    }

    return response;
  },
};
