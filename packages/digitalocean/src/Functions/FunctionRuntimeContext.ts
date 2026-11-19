import type { HttpEffect } from "alchemy/Http";
import * as Output from "alchemy/Output";
import {
  packEnvValueKeepRedacted,
  unpackEnvValue,
  type BaseRuntimeContext,
} from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The runtime context of a `DigitalOcean.Functions.Function`. */
export interface FunctionRuntimeContext extends BaseRuntimeContext {
  /** The request handler and the services captured when it was registered. */
  handler: Effect.Effect<{ handler: HttpEffect; context: Context.Context<never> }>;
}

export const makeFunctionRuntimeContext = (id: string): FunctionRuntimeContext => {
  const env: Record<string, Output.Output> = {};
  let handler: HttpEffect = Effect.succeed(HttpServerResponse.empty({ status: 404 }));
  let context = Context.empty();
  return {
    Type: "DigitalOcean.Functions.Function",
    id,
    env,
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- runtime ctx.get must read raw env, never Config (see unpackEnvValue)
    get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(process.env[key])),
    set: (key, value) =>
      Effect.sync(() => {
        env[key] = value.pipe(Output.map(packEnvValueKeepRedacted));
        return key;
      }),
    serve: (next) =>
      Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the bridge provides the request service at call time
        handler = next as HttpEffect;
        context = Context.omit(Layer.CurrentMemoMap)(yield* Effect.context<never>());
      }),
    handler: Effect.sync(() => ({ handler, context })),
  };
};
