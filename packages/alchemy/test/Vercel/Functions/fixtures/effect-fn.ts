/**
 * Effect-mode Vercel Function fixture (two-phase class pattern): exercises
 * the runtime bridge — HttpServerRequest/HttpServerResponse handlers,
 * post-response request finalizers, the `Function.URL` accessor, and a
 * secret-guarded cron route.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Instance-global counters: written by request finalizers / the cron
// handler, read back over HTTP on the same warm Fluid instance.
let finalized = 0;
let cronFires = 0;

export default class EffectFn extends Vercel.Function<EffectFn>()(
  "EffectFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const selfUrl = yield* Vercel.Function.URL;
    yield* Vercel.cron(
      "0 3 * * *",
      Effect.sync(() => {
        cronFires++;
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/self")) {
          return yield* HttpServerResponse.json({ url: yield* selfUrl });
        }
        if (request.url.startsWith("/finalized")) {
          return yield* HttpServerResponse.json({ finalized, cronFires });
        }
        if (request.url.startsWith("/finalize")) {
          // The finalizer sleeps well past the response: proves request
          // finalizers settle post-response (waitUntil) instead of
          // blocking the reply.
          yield* Effect.addFinalizer(() =>
            Effect.sleep("3 seconds").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  finalized++;
                }),
              ),
            ),
          );
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (request.url.startsWith("/slow")) {
          yield* Effect.sleep("500 millis");
          return yield* HttpServerResponse.json({ slow: true });
        }
        return yield* HttpServerResponse.json({ ok: true, path: request.url });
      }),
    };
  }).pipe(Effect.provide(Vercel.CronEventSourceLive)),
) {}
