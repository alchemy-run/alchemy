import type { WorkerEnv } from "../alchemy.run.ts";

export default {
  fetch: async (request: Request, env: WorkerEnv) => {
    if (
      request.method === "GET" &&
      prefersMarkdown(request.headers.get("accept"))
    ) {
      const mdUrl = toMarkdownUrl(new URL(request.url)).toString();
      const res = await env.ASSETS.fetch(new Request(mdUrl, request));
      if (res.status !== 404) return res;
    }
    return env.ASSETS.fetch(request);
  },
};

function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  if (lower.includes("text/html")) return false;
  return lower.includes("text/markdown") || lower.includes("text/plain");
}

function toMarkdownUrl(url: URL): URL {
  const md = new URL(url.toString());
  let p = md.pathname.replace(/\/$/, "");
  if (p === "") p = "/index";
  md.pathname = `${p}.md`;
  return md;
}
