/**
 * Async-mode Vercel Function fixture for the EdgeConfig read client: no
 * Effect runtime — reads the connection string bound to the `FLAGS` env
 * var with the promise-based `readEdgeConfigFromEnv` client.
 */
import { readEdgeConfigFromEnv } from "@/Vercel/EdgeConfig/EdgeConfigRead.ts";

const flags = readEdgeConfigFromEnv("FLAGS");

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path.startsWith("/item/")) {
        const key = decodeURIComponent(path.slice("/item/".length));
        return Response.json({ value: (await flags.get(key)) ?? null });
      }
      if (path.startsWith("/has/")) {
        const key = decodeURIComponent(path.slice("/has/".length));
        return Response.json({ has: await flags.has(key) });
      }
      if (path.startsWith("/all")) {
        return Response.json({ items: await flags.getAll() });
      }
      if (path.startsWith("/digest")) {
        return Response.json({ digest: await flags.digest() });
      }
      // Raw env visibility: proves the sensitive row landed as the plain
      // connection string (not marker-packed) on the async channel.
      if (path.startsWith("/env")) {
        const raw = process.env.FLAGS ?? null;
        return Response.json({
          present: raw !== null,
          isUrl: raw?.startsWith("https://edge-config.vercel.com/") ?? false,
        });
      }
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
};
