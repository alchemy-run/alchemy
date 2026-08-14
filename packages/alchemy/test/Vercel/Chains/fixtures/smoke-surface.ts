/**
 * Async-mode (no Effect runtime) "surface" Function for the aggregate
 * smoke chain: a plain web-standard `{ fetch }` export whose only wiring
 * is the env channel — `API_URL` (the Api's read-back production URL
 * attribute Output) and `API_BYPASS` (the Api's Redacted protection-bypass
 * secret). `/call` proxies the Api's `/version`, proving the env-bound URL
 * reaches the CURRENT production deployment of the Api across redeploys,
 * rollbacks, and promotes — without this function ever redeploying.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/call") {
      const target = process.env.API_URL;
      if (target === undefined || target === "") {
        return Response.json({ error: "API_URL not set" }, { status: 500 });
      }
      const headers: Record<string, string> = {};
      const bypass = process.env.API_BYPASS;
      if (bypass !== undefined && bypass !== "") {
        headers["x-vercel-protection-bypass"] = bypass;
      }
      const res = await fetch(`${target}/version`, { headers });
      return Response.json({ status: res.status, body: await res.json() });
    }
    return Response.json({ ok: true });
  },
};
