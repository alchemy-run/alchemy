/// <reference types="@cloudflare/workers-types" />

import type { OutboundParams } from "./shared.ts";

/**
 * Outbound Worker for {@link OutboundDispatch}. Every `fetch()` a dispatched
 * user Worker makes arrives here instead of the internet, with the
 * dispatcher's per-call `outbound` values on `env`. It answers with the URL
 * the user Worker asked for and the `tenant` it was given, so the test can
 * tell an intercepted request from one that reached the origin.
 */
export default {
  fetch(request: Request, env: OutboundParams): Response {
    return Response.json({ seen: request.url, tenant: env.tenant });
  },
};
