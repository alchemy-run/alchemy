import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EventsStream } from "./stream.ts";

/**
 * The runtime handle `EVENTS` resolves to. Derived from the stream rather
 * than from `InferEnv<typeof PipelinesEffectWorker>` — the latter would be
 * a circular reference inside the class's own body — but it exercises the
 * same mapping: `Pipelines.Stream` to `Pipeline`.
 */
type EffectWorkerEnv = {
  EVENTS: Cloudflare.GetBindingType<typeof EventsStream>;
};

/**
 * Effect-native Worker fixture for the Pipelines stream binding. Pipelines
 * has no `Binding.Service` capability, so the stream is declared on `env`
 * and the runtime handle is read off `WorkerEnvironment`.
 */
export default class PipelinesEffectWorker extends Cloudflare.Worker<PipelinesEffectWorker>()(
  "PipelinesEffectWorker",
  {
    main: import.meta.url,
    env: {
      EVENTS: EventsStream,
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://x");
        const env = (yield* Cloudflare.Workers
          .WorkerEnvironment) as EffectWorkerEnv;
        if (url.pathname === "/send") {
          yield* Effect.promise(() =>
            env.EVENTS.send([
              {
                source: "pipelines-binding-test",
                nonce: url.searchParams.get("nonce") ?? "none",
              },
            ]),
          );
          return yield* HttpServerResponse.json({
            mode: "effect",
            sent: true,
            kind: typeof env.EVENTS.send,
          });
        }
        return yield* HttpServerResponse.json({
          mode: "effect",
          sent: false,
          kind: typeof env.EVENTS.send,
        });
      }),
    };
  }),
) {}
