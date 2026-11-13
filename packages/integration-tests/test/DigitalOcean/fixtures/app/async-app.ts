// A plain fetch handler, served by DigitalOcean.App without an Effect runtime.
export default {
  async fetch(request: Request, env: Record<string, string | undefined>) {
    return Response.json({
      runtime: "async",
      greeting: env.GREETING,
      path: new URL(request.url).pathname,
    });
  },
};
