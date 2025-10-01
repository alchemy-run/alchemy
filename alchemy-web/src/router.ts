interface Env {
  ASSETS: Fetcher;
  VERSION: WorkerVersionMetadata;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // namespace cache by version id to avoid cache invalidation issues
    // TODO: this is probably too aggressive; we should probably namespace by asset hash
    const cache = await caches.open(env.VERSION.id);
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    const response = await handleRequest(request, env);
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};

const handleRequest = async (request: Request, env: Env) => {
  const url = new URL(request.url);

  if (acceptsMarkdown(request)) {
    const rewrite = new URL(url.pathname.replace(/\/?$/, ".md"), url.origin);
    const markdownResponse = await env.ASSETS.fetch(rewrite);
    if (markdownResponse.ok) {
      // force trailing slash to match the HTML version
      if (!url.pathname.endsWith("/")) {
        url.pathname += "/";
        return Response.redirect(url);
      }
      return withVary(markdownResponse);
    }
  }

  const assetResponse = await env.ASSETS.fetch(url);
  if (assetResponse.ok || assetResponse.redirected) {
    return withVary(assetResponse);
  }

  const response = await env.ASSETS.fetch(new URL("/404.html", url.origin));
  return new Response(response.body, {
    ...response,
    status: 404,
  });
};

const acceptsMarkdown = (request: Request) => {
  const accept = request.headers.get("accept");
  if (!accept || accept.includes("text/html")) return false;
  return accept.includes("text/markdown") || accept.includes("text/plain");
};

const withVary = (response: Response) => {
  const contentType = response.headers.get("content-type");
  if (
    contentType?.includes("text/html") ||
    contentType?.includes("text/markdown")
  ) {
    return new Response(response.body, {
      ...response,
      headers: {
        ...response.headers,
        Vary: "Accept",
      },
    });
  }
  return response;
};
