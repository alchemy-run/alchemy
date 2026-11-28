// A custom Worker in front of a browser-only Effect UI app: it answers its
// own route and hands everything else to the asset layer.
interface Env {
  readonly GREETING: string;
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/greeting") {
      return new Response(env.GREETING);
    }
    return env.ASSETS.fetch(request);
  },
};
