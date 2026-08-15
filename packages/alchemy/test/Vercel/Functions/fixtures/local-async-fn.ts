/**
 * Local-dev async fixture: web-standard default `{ fetch }` export (arm 1
 * of the launcher matrix). Reads the env the local provider injects.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/env") {
      return Response.json({
        greeting: process.env.GREETING ?? null,
        vercel: process.env.VERCEL ?? null,
        vercelEnv: process.env.VERCEL_ENV ?? null,
        vercelUrl: process.env.VERCEL_URL ?? null,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
        selfUrl: process.env.SELF_URL ?? null,
      });
    }
    if (url.pathname === "/headers") {
      return Response.json({
        vercelId: request.headers.get("x-vercel-id"),
        country: request.headers.get("x-vercel-ip-country"),
        proto: request.headers.get("x-forwarded-proto"),
        host: request.headers.get("host"),
      });
    }
    if (url.pathname === "/echo" && request.method === "POST") {
      return Response.json({ echo: await request.text() });
    }
    return Response.json({ ok: true, path: url.pathname });
  },
};
