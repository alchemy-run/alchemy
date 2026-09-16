import type { Pipeline } from "cloudflare:pipelines";
interface Env {
  EVENTS: Pipeline;
  BUCKET: R2Bucket;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "POST") {
      try {
        await env.EVENTS.send(await request.json());
        return Response.json({ sent: true });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    }
    const objects = await env.BUCKET.list();
    const values = await Promise.all(
      objects.objects.map(async ({ key }) => {
        const object = await env.BUCKET.get(key);
        if (!object) throw new Error(`Missing fixture object ${key}`);
        const text =
          object.httpMetadata?.contentEncoding === "gzip"
            ? await new Response(
                object.body.pipeThrough(new DecompressionStream("gzip")),
              ).text()
            : await object.text();
        return {
          key,
          rows: text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        };
      }),
    );
    return Response.json(values);
  },
} satisfies ExportedHandler<Env>;
