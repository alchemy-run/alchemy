/**
 * Async-mode Vercel Function fixture: a plain web-standard `{ fetch }`
 * export — no Effect runtime, no bridge. Vercel's Node launcher accepts
 * this shape natively.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/env") {
      return Response.json({
        greeting: process.env.GREETING ?? null,
        secret: process.env.SECRET_VALUE !== undefined,
        secretValue: process.env.SECRET_VALUE ?? null,
        selfUrl: process.env.SELF_URL ?? null,
      });
    }
    if (url.pathname === "/echo" && request.method === "POST") {
      const body = await request.text();
      return Response.json({ echo: body });
    }
    return Response.json({ ok: true, path: url.pathname });
  },
};
