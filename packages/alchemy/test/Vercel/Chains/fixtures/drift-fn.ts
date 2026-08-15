/**
 * Async-mode Vercel Function fixture for the adoption + drift chain: reads
 * the Edge Config through the `FLAGS` connection-string env row and exposes
 * the raw env rows the chain tampers with out-of-band.
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
      if (path.startsWith("/env")) {
        return Response.json({
          appMode: process.env.APP_MODE ?? null,
          secretValue: process.env.SECRET_VALUE ?? null,
          flagsPresent: process.env.FLAGS !== undefined,
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
