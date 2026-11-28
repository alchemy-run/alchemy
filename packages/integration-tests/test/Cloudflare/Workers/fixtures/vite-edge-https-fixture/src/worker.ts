// `/whoami` reports the `Host` and URL the Worker saw, which pins that a
// request routed through the local edge arrives with its original URL.
type Env = { ASSETS: { fetch: (req: Request) => Promise<Response> }; REVISION?: string };

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname === "/whoami") {
      return Response.json({
        worker: "vite",
        url: request.url,
        host: url.host,
        revision: env.REVISION,
      });
    }
    return env.ASSETS.fetch(request);
  },
};
