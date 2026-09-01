import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

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
