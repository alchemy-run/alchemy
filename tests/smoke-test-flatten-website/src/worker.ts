import type { queue, worker } from "../alchemy.run.ts";

export * from "./do.ts";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/increment")) {
      return Response.json({
        count: await env.DO.getByName("foo").increment(),
      });
    } else if (url.pathname.startsWith("/object")) {
      if (request.method === "POST") {
        await env.BUCKET.put("key", "value");
        return Response.json({
          key: await getObject(),
        });
      } else if (request.method === "GET") {
        return Response.json({
          key: await getObject(),
        });
      } else {
        return Response.json(
          {
            error: "Method not allowed",
          },
          { status: 405 },
        );
      }
    } else if (url.pathname.startsWith("/queue")) {
      const url = new URL(request.url);
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json(
          {
            error: "Message is required",
          },
          { status: 400 },
        );
      }
      await env.QUEUE.send(key, {
        delaySeconds: 30,
      });
      return Response.json({});
    } else if (url.pathname.startsWith("/check")) {
      const url = new URL(request.url);
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json(
          {
            error: "Message is required",
          },
          { status: 400 },
        );
      }
      const value = await env.KV.get(key);
      return Response.json({
        value,
      });
    }

    return new Response(null, { status: 404 });

    async function getObject(): Promise<string | null> {
      return (await (await env.BUCKET.get("key"))?.text()) ?? null;
    }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      await env.KV.put(message.body, "exists");
      message.ack();
    }
  },
} satisfies ExportedHandler<typeof worker.Env, typeof queue.Body>;
