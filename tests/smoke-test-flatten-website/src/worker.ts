import type { worker } from "../alchemy.run.ts";

export * from "./do.ts";

export default {
  async fetch(request, env: typeof worker.Env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/increment")) {
      return Response.json({
        count: await env.DO.getByName("foo").increment()
      })
    }
    return new Response(null, { status: 404 });
  },
  queue(batch) {
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
