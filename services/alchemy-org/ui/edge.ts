/**
 * The SPA site's worker entry — the thinnest possible edge: every
 * request that reaches it (assets config routes only `/api/*` and
 * `/attach/*` worker-first; everything else is a static asset or the
 * SPA fallback) forwards verbatim to the bound {@link Worker}
 * backend. WebSocket upgrades (`/attach`) pass through the service
 * binding unchanged.
 */
type Env = {
  readonly ORG: { readonly fetch: (request: Request) => Promise<Response> };
};

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    env.ORG.fetch(request),
};
