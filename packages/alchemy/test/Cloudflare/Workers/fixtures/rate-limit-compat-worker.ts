import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The #1443 alchemy.run.ts shape: Worker is a named export, Stack is the
 * default. `main: import.meta.url` would bundle the default (the Stack)
 * unless `handler` names the Worker export.
 */
export const api = Cloudflare.Worker(
  "api",
  {
    main: import.meta.url,
    handler: "api",
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
);

export default Alchemy.Stack(
  "RateLimitCompatStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    return yield* api;
  }),
);
