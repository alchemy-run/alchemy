interface Env {
  ASSETS: Fetcher;
  VERSION: WorkerVersionMetadata;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (!url.pathname.endsWith(".md") && prefersMarkdown(request)) {
      const markdownResponse = await env.ASSETS.fetch(
        new URL(url.pathname.replace(/\/?$/, ".md"), url.origin),
      );
      if (markdownResponse.ok) {
        return markdownResponse;
      }
    }

    const assetResponse = await env.ASSETS.fetch(url);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }

    const notFoundResponse = await env.ASSETS.fetch(
      new URL("/404.html", url.origin),
    );
    return new Response(notFoundResponse.body, {
      ...notFoundResponse,
      status: 404,
    });
  },
};

/**
 * Returns true if the accept header prefers markdown or plain text over HTML.
 *
 * Examples:
 * - opencode - accept: text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, *\/*;q=0.1
 * - claude code - accept: application/json, text/plain, *\/*
 *
 * Notes:
 * - ChatGPT and Claude web don't set an accept header; maybe check the user agent instead?
 * - Cursor's headers are too generic (accept: *, user-agent: https://github.com/sindresorhus/got)
 */
const prefersMarkdown = (request: Request) => {
  const accept = request.headers.get("accept");
  if (!accept) return false;
  return (
    accept === "application/json, text/plain, */*" ||
    accept ===
      "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
  );
};
