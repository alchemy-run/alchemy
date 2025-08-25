import type { worker } from "../alchemy.run.ts";

export * from "./do.ts";

export default {
  async fetch(request, env: typeof worker.Env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/increment")) {
      return Response.json({
        count: await env.DO.getByName("foo").increment()
      })
    } else if (url.pathname.startsWith("/object")) {
      if (request.method === "POST") {
        await env.BUCKET.put("key", "value");
        return Response.json({
          key: await getObject()
        });
      } else if (request.method === "GET") {
        return Response.json({
          key: await getObject()
        });
      } else {
        return Response.json({
          error: "Method not allowed"
        }, { status: 405 });
      }
    }

    return new Response(null, { status: 404 });

    async function getObject(): Promise<string | null> {
      return await (await env.BUCKET.get("key"))?.text() ?? null
    }
  },
  queue(batch) {
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
