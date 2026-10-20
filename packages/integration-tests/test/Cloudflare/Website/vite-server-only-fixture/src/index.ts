// A server-only Worker: no `index.html`, static files only in `public/`.
interface Env {
  ASSETS?: Fetcher;
}

export default {
  fetch: (request: Request, env: Env) => {
    if (new URL(request.url).pathname === "/__assets") {
      return Response.json({ assets: env.ASSETS !== undefined });
    }
    return env.ASSETS
      ? env.ASSETS.fetch(request)
      : new Response("no ASSETS binding", { status: 500 });
  },
};
