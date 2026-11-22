/**
 * Stand-in for a framework's Azure target output (`serve-azure.mjs`): a
 * Fetch handler the site's Function runs for every non-asset path.
 */
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") ?? url.host;
    return new Response(`<h1>rendered ${url.pathname} for ${host}</h1>`, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-rendered-by": "azure-function",
      },
    });
  },
};
