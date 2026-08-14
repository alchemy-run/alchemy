/**
 * Tenant-cohabitation chain fixture: a plain web-standard `{ fetch }`
 * export (async mode, no Effect bridge). `/env` reports the per-deployment
 * tenant env (`GREETING`) so the chain can prove per-deployment delivery
 * and redeploy propagation over HTTP.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/env") {
      return Response.json({
        greeting: process.env.GREETING ?? null,
        cohab: process.env.COHAB_FLAG ?? null,
      });
    }
    return Response.json({ ok: true, path: url.pathname });
  },
};
