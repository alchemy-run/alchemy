/**
 * Effect-mode Vercel Function fixture for the MIXED dev-mode stack: one
 * locally emulated Edge Config plus one `Alchemy.remote()` (real) Edge
 * Config, both bound via `Vercel.ReadEdgeConfig` into the SAME locally
 * running Function. Routes are prefixed `/local/…` and `/live/…`.
 */
import { remote } from "@/ProviderMode.ts";
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { ReadEdgeConfigClient } from "@/Vercel/EdgeConfig/EdgeConfigRead.ts";

export const MIXED_LOCAL_ITEMS = { source: "local", n: 1 };
export const MIXED_LIVE_ITEMS = { source: "live", n: 2 };

export const MixedLocalFlags = Vercel.EdgeConfig("MixedLocalFlags", {
  items: { ...MIXED_LOCAL_ITEMS },
});

/** Runs LIVE even during `alchemy dev` — the local-emulation opt-out. */
export const MixedLiveFlags = Vercel.EdgeConfig("MixedLiveFlags", {
  items: { ...MIXED_LIVE_ITEMS },
}).pipe(remote());

export default class MixedEdgeFn extends Vercel.Function<MixedEdgeFn>()(
  "MixedEdgeFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const local = yield* MixedLocalFlags;
    const live = yield* MixedLiveFlags;
    const localConfig = yield* Vercel.ReadEdgeConfig(local);
    const liveConfig = yield* Vercel.ReadEdgeConfig(live);

    const serve = (config: ReadEdgeConfigClient, path: string) =>
      Effect.gen(function* () {
        if (path.startsWith("/item/")) {
          const key = decodeURIComponent(path.slice("/item/".length));
          const value = yield* config.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
        }
        if (path.startsWith("/all")) {
          const items = yield* config.getAll().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ items });
        }
        if (path.startsWith("/digest")) {
          const digest = yield* config.digest().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ digest });
        }
        return yield* HttpServerResponse.json({ ok: true });
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = request.url.split("?")[0]!;
        if (path.startsWith("/local")) {
          return yield* serve(localConfig, path.slice("/local".length));
        }
        if (path.startsWith("/live")) {
          return yield* serve(liveConfig, path.slice("/live".length));
        }
        return yield* HttpServerResponse.json({ ok: true });
      }),
    };
  }).pipe(Effect.provide(Vercel.ReadEdgeConfigHttp)),
) {}
