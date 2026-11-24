/// <reference types="@cloudflare/workers-types" />

import type { OutboundParams } from "./shared.ts";

/**
 * Outbound Worker that another stack deploys, reached through
 * `Cloudflare.Worker.ref`. It answers like `outbound-worker.ts` and says so.
 */
export default {
  fetch(request: Request, env: OutboundParams): Response {
    return Response.json({ seen: request.url, tenant: env.tenant, via: "ref" });
  },
};
