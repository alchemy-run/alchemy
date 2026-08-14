/**
 * Async-mode Vercel Function fixture for the StateStoreCycles chain: reads
 * the Edge Config connection string bound to the `FLAGS` env var with the
 * promise-based `readEdgeConfigFromEnv` client. Kept async-mode (no Effect
 * runtime) so the chain pins the binding-as-env-value form — the props are
 * fully declared inline by the test, which is what lets each reconciliation
 * cycle vary the Edge Config items without touching this file.
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
      if (path.startsWith("/all")) {
        return Response.json({ items: await flags.getAll() });
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
