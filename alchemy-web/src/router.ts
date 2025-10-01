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

  const accept = request.headers.get("accept");
  if (accept && prefersMarkdown(accept)) {
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

/**
 * Returns true if the accept header prioritizes markdown or plain text over HTML.
 *
 * Examples:
 * - opencode: text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, *\/*;q=0.1 > true
 * - claude code: application/json, text/plain, *\/* > true
 */
const prefersMarkdown = (accept: string) => {
  // parse accept header and sort by quality; highest quality first
  const types = accept
    .split(",")
    .map((part) => {
      const type = part.split(";")[0].trim();
      const q = part.match(/q=([^,]+)/)?.[1];
      return { type, q: q ? Number.parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q)
    .map((type) => type.type);

  const markdown = types.indexOf("text/markdown");
  const plain = types.indexOf("text/plain");
  const html = types.indexOf("text/html");

  // if no HTML is specified, and either markdown or plain text is specified, prefer markdown
  if (html === -1) {
    return markdown !== -1 || plain !== -1;
  }

  // prefer markdown if higher quality than HTML
  if ((markdown !== -1 && markdown < html) || (plain !== -1 && plain < html)) {
    return true;
  }

  // otherwise, prefer HTML
  return false;
};

/**
 * Adds a Vary: Accept header to the response if the content type is text/html or text/markdown.
 */
const withVary = (response: Response) => {
  const contentType = response.headers.get("content-type");
  if (
    contentType?.includes("text/html") ||
    contentType?.includes("text/markdown")
  ) {
    const headers = new Headers(response.headers);
    headers.append("vary", "accept");
    return new Response(response.body, {
      ...response,
      headers,
    });
  }
  return response;
};
