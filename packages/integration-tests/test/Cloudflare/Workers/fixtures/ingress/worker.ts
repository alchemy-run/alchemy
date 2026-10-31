/// <reference types="@cloudflare/workers-types" />

type Env = { SELF_URL: string };

/**
 * Plain Worker for the dev ingress tests. `/self-url` reports the URL the
 * Worker was given for itself (`Worker.URL`); every other path echoes the
 * `Host` it was reached on, so a test sees the routed name arrive.
 */
export default {
  fetch(request: Request, env: Env): Response {
    const url = new URL(request.url);
    if (url.pathname === "/self-url") {
      return Response.json({ env: env.SELF_URL });
    }
    return new Response(`ingress-worker host=${request.headers.get("host")} path=${url.pathname}`);
  },
};
