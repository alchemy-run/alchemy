import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Minimal worker for the Access worker-destination test. Serves a marker
 * body plus the request's `ctx.access` view, so the test can distinguish
 * "worker answered directly" from "Access intercepted the request".
 */
export default class AccessProtectedWorker extends Cloudflare.Worker<AccessProtectedWorker>()(
  "AccessProtectedWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const exec = yield* Cloudflare.WorkerExecutionContext;
    return {
      fetch: Effect.gen(function* () {
        const access = yield* exec.access;
        const identity =
          access === undefined
            ? undefined
            : yield* access.getIdentity().pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          marker: "alchemy-access-worker-open",
          authenticated: access !== undefined,
          aud: access?.aud,
          email: identity?.email,
        });
      }),
    };
  }),
) {}
