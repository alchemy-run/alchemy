import type { OutboundParams } from "./shared.ts";

/**
 * Outbound Worker: every `fetch()` a dispatched user Worker makes arrives
 * here instead of the internet, with the dispatcher's `outbound` values on
 * `env`. It answers with the URL the user Worker asked for and the `tenant`
 * it was given, and `VIA`, its own binding, says which outbound Worker it is.
 */
export default {
  fetch(request: Request, env: OutboundParams & { VIA: string }): Response {
    return Response.json({ seen: request.url, tenant: env.tenant, via: env.VIA });
  },
};
