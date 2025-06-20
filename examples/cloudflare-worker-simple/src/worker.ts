import crypto from "node:crypto";
import type { worker } from "../alchemy.run.ts";

export default {
  async fetch(
    request: Request,
    env: typeof worker.Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    console.log("url", url);
    switch (url.pathname) {
      case "/":
        return Response.json({
          list: await env.AI.models(),
        });
      case "/upload": {
        await env.KV.put(crypto.randomUUID(), crypto.randomBytes(16));
        return Response.json({ success: true });
      }
      case "/download": {
        const file = await env.KV.get(url.searchParams.get("name") ?? "");
        if (!file) {
          return Response.json({ error: "File not found" }, { status: 404 });
        }
        return new Response(file);
      }
      default:
        return Response.json({ error: "Not found" }, { status: 404 });
    }
  },
};
