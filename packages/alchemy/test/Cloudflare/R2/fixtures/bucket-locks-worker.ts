/// <reference types="@cloudflare/workers-types" />
export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket }) {
    const path = new URL(request.url).pathname;
    if (path === "/seed") {
      await env.BUCKET.put("audit/log", "original");
      return new Response("seeded");
    }
    if (path === "/read")
      return new Response(await (await env.BUCKET.get("audit/log"))?.text());
    try {
      if (path === "/delete") await env.BUCKET.delete("audit/log");
      else await env.BUCKET.put("audit/log", "changed");
      return Response.json({ allowed: true });
    } catch {
      return Response.json({ allowed: false });
    }
  },
};
