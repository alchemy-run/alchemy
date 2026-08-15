/**
 * Async-mode upstream target of the one-way invoke chain
 * (`ChainUpstreamA` ← InvokeFunction ← `ChainCallerB`): a plain
 * web-standard `{ fetch }` export, no Effect runtime. Being async-mode is
 * deliberate — it pins that a `Vercel.invoke({ LogicalId })` forward
 * reference binds attribute Outputs off ANY Function row, not just
 * Effect-mode class fixtures.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/echo") {
      return Response.json({
        fn: "upstream-a",
        echo: url.pathname + url.search,
      });
    }
    return Response.json({ ok: true, fn: "upstream-a" });
  },
};
