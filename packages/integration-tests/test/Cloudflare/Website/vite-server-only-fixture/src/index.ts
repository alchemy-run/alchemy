// A server-only Worker: no `index.html`, static files only in `public/`.
interface Env {
  ASSETS?: Fetcher;
}

export default {
  fetch: (request: Request, env: Env) =>
    env.ASSETS ? env.ASSETS.fetch(request) : new Response("no ASSETS binding", { status: 500 }),
};
