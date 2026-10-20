// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.

/**
 * Outbound interceptor at the top of the user Worker's `globalOutbound`
 * chain, ported from Miniflare's `workers/core/outbound.worker.ts`: every
 * outbound `fetch()` drops `CF-Connecting-IP` and carries `CF-Worker` with
 * the Worker's zone, as on Cloudflare's edge, then continues to the internet.
 */
interface Env {
  CF_WORKER_ZONE: string;
}

export default {
  fetch(request: Request, env: Env) {
    const headers = new Headers(request.headers);
    headers.delete("CF-Connecting-IP");
    headers.set("CF-Worker", env.CF_WORKER_ZONE);
    return fetch(request, { headers });
  },
};
