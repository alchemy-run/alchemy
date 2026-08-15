/**
 * Effect-mode Vercel Function fixture for the EdgeConfigRead capability:
 * declares an Edge Config with items, binds it via
 * `Vercel.ReadEdgeConfig`, and exposes one HTTP route per client method
 * (get / getAll / has / digest).
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Flags } from "./flags.ts";

export default class EdgeConfigFn extends Vercel.Function<EdgeConfigFn>()(
  "EdgeConfigFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const flags = yield* Flags;
    const config = yield* Vercel.ReadEdgeConfig(flags);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = request.url.split("?")[0]!;
        if (path.startsWith("/item/")) {
          const key = decodeURIComponent(path.slice("/item/".length));
          const value = yield* config.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
        }
        if (path.startsWith("/has/")) {
          const key = decodeURIComponent(path.slice("/has/".length));
          const has = yield* config.has(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ has });
        }
        if (path.startsWith("/some")) {
          const items = yield* config
            .getAll(["greeting", "enableCheckout"])
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ items });
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
      }),
    };
  }).pipe(Effect.provide(Vercel.ReadEdgeConfigHttp)),
) {}
