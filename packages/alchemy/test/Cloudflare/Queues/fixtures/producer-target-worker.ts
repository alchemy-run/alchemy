/// <reference types="@cloudflare/workers-types" />

/**
 * Target worker: holds a queue PRODUCER binding for a queue nothing
 * consumes, and serves plain HTTP. Reached both directly and through a
 * caller's service binding.
 */
interface Env {
  QUEUE: { send(body: unknown): Promise<void> };
}

export default {
  fetch: async (request: Request, _env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/ping") {
      return new Response("pong from target");
    }
    return new Response("target up");
  },
};
