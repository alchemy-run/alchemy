/// <reference types="@cloudflare/workers-types" />

/** Caller worker: forwards to the target through its service binding. */
export default {
  async fetch(request: Request, env: { BACKEND: Service }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/via-binding") {
      try {
        const res = await env.BACKEND.fetch(new Request("http://backend/ping"));
        return new Response(`${res.status}:${await res.text()}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`caller failed: ${message}`, { status: 500 });
      }
    }
    return new Response("caller up");
  },
};
