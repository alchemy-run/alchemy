/**
 * Effect-mode Vercel Function fixture for the EXPLICIT-OPT-IN
 * EdgeConfigWrite capability: declares an Edge Config, binds it via
 * `Vercel.WriteEdgeConfig` with a USER-SUPPLIED management token
 * (`Config.redacted("VERCEL_TOKEN")`, resolved from the deploy
 * environment and synced as a sensitive project env var), and exposes one
 * HTTP route per client method (set / delete / patch).
 *
 * Deployed only when `VERCEL_TEST_EDGE_CONFIG_WRITE=1` — binding a
 * team-wide management token into a Function is the documented tradeoff
 * the caller must accept (see EdgeConfigWrite's Runtime authorization
 * JSDoc).
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Seeded declaratively; mutated at runtime through the write binding. */
export const WRITE_FIXTURE_ITEMS = { seeded: "v1" };

export const WriteFlags = Vercel.EdgeConfig("WriteFlags", {
  items: { ...WRITE_FIXTURE_ITEMS },
});

export default class WriteEdgeConfigFn extends Vercel.Function<WriteEdgeConfigFn>()(
  "WriteEdgeConfigFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const flags = yield* WriteFlags;
    const writer = yield* Vercel.WriteEdgeConfig(flags);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [path, query] = request.url.split("?") as [
          string,
          string | undefined,
        ];
        const params = new URLSearchParams(query ?? "");
        if (path === "/set") {
          const key = params.get("key") ?? "k";
          const value = params.get("value") ?? "v";
          yield* writer.set({ [key]: value }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (path === "/delete") {
          const key = params.get("key") ?? "k";
          yield* writer.delete([key]).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (path === "/patch") {
          const key = params.get("key") ?? "k";
          const value = params.get("value") ?? "v";
          const drop = params.get("drop");
          yield* writer
            .patch([
              { operation: "upsert", key, value },
              ...(drop === null
                ? []
                : [{ operation: "delete" as const, key: drop }]),
            ])
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }
        return yield* HttpServerResponse.json({ ok: true });
      }),
    };
  }).pipe(
    Effect.provide(
      // EXPLICIT opt-in: the write token is supplied by the composition,
      // never auto-bound. Resolved on the DEPLOY machine's environment.
      Vercel.WriteEdgeConfigHttp({ token: Config.redacted("VERCEL_TOKEN") }),
    ),
  ),
) {}
