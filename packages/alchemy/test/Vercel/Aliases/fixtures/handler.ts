/**
 * Async-mode Vercel Function fixture for alias tests: reports the VERSION
 * env var it was deployed with, so two retained deployments (v1/v2) are
 * distinguishable over HTTP.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      version: process.env.VERSION ?? null,
      path: url.pathname,
    });
  },
};
