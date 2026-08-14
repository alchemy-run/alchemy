/**
 * Async-mode caller fixture for the one-way InvokeFunction env test: a
 * plain web-standard `{ fetch }` export (no Effect runtime) that calls the
 * target function through `TARGET_URL` (an attribute Output bound on the
 * env channel), sending the target's protection-bypass secret when bound.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/call") {
      const target = process.env.TARGET_URL;
      if (target === undefined || target === "") {
        return Response.json({ error: "TARGET_URL not set" }, { status: 500 });
      }
      const headers: Record<string, string> = {};
      const bypass = process.env.TARGET_BYPASS;
      if (bypass !== undefined && bypass !== "") {
        headers["x-vercel-protection-bypass"] = bypass;
      }
      const res = await fetch(`${target}/echo`, {
        method: "POST",
        headers,
        body: "hi from caller",
      });
      return Response.json({ status: res.status, body: await res.json() });
    }
    return Response.json({ ok: true });
  },
};
