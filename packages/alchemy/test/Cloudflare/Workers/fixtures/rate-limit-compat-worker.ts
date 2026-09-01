import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Issue #1443: Effect-native Worker with RateLimit, explicit
 * `nodejs_compat`, default compatibility date, `main: import.meta.url`,
 * and `Cloudflare.providers()` in the same module — the reported
 * `alchemy.run.ts` shape.
 */
const providers = Cloudflare.providers;

export default class RateLimitCompatWorker extends Cloudflare.Worker<RateLimitCompatWorker>()(
  "RateLimitCompatWorker",
  {
    main: import.meta.url,
    compatibility: {
      flags: ["nodejs_compat"],
    },
    dev: { port: 0 },
  },
  Effect.gen(function* () {
    yield* Effect.sync(() => providers);
    const throttle = yield* Cloudflare.RateLimit("THROTTLE", {
      namespaceId: 1001,
      simple: { limit: 10, period: 60 },
    });
    return {
      fetch: Effect.gen(function* () {
        const { success } = yield* throttle
          .limit({ key: "ip" })
          .pipe(Effect.orDie);
        return success
          ? HttpServerResponse.text("ok")
          : HttpServerResponse.text("rate limited", { status: 429 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.RateLimitBinding)),
) {}
