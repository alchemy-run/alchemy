/**
 * Local-dev Effect-mode fixture: the two-phase class pattern running
 * through `makeVercelBridge` inside the dev shim — pins that the bridge
 * entry works locally (mode inline, no cloud), that the cron event source
 * registers its guarded route, and that injected env is visible.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Instance-global counter: written by the cron handler, read back over
// HTTP on the same dev-server instance.
let cronFires = 0;

export default class LocalEffectFn extends Vercel.Function<LocalEffectFn>()(
  "LocalEffectFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    yield* Vercel.cron(
      "0 3 * * *",
      Effect.sync(() => {
        cronFires++;
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/cron-fires")) {
          return yield* HttpServerResponse.json({ cronFires });
        }
        if (request.url.startsWith("/env")) {
          return yield* HttpServerResponse.json({
            vercelEnv: process.env.VERCEL_ENV ?? null,
            deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
          });
        }
        return yield* HttpServerResponse.json({ ok: true, path: request.url });
      }),
    };
  }).pipe(Effect.provide(Vercel.CronEventSourceLive)),
) {}
