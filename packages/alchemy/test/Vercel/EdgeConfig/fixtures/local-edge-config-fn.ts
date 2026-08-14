/**
 * Effect-mode Vercel Function fixture for the dev-mode EdgeConfigRead
 * roundtrip: binds the locally emulated {@link LocalFlags} config via
 * `Vercel.ReadEdgeConfig` and exposes one HTTP route per client method
 * (get / has / getAll / digest) — identical shape to the live fixture, so
 * the dev data plane is exercised through the exact same client surface.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { LocalFlags } from "./local-flags.ts";

export default class LocalEdgeFn extends Vercel.Function<LocalEdgeFn>()(
  "LocalEdgeFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const flags = yield* LocalFlags;
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
