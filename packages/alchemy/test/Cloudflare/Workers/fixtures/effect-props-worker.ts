import * as Cloudflare from "@/Cloudflare/index.ts";
import { Stage } from "@/Stage.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Class-form Worker whose props are an Effect that depends on `Stage` —
 * the "stage-specific domain" pattern. The props effect re-evaluates
 * inside the deployed Worker, so this fixture proves the runtime bridge
 * provides `Stage` (a missing service would defect at init and 500
 * every request). The stage value flows through props `env` so the
 * handler can echo what the props effect actually computed.
 */
export default class EffectPropsWorker extends Cloudflare.Worker<EffectPropsWorker>()(
  "EffectPropsWorker",
  Effect.gen(function* () {
    const stage = yield* Stage;
    return {
      main: import.meta.url,
      env: { PROPS_STAGE: stage },
    };
  }),
  Effect.gen(function* () {
    const env = yield* Cloudflare.WorkerEnvironment;
    return {
      fetch: Effect.succeed(
        HttpServerResponse.text(`effect-props-stage:${env.PROPS_STAGE}`),
      ),
    };
  }),
) {}
