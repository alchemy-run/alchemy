import { AlchemyContext } from "alchemy/AlchemyContext";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** `alchemy dev` publishes no DNS, unless the resource is `Alchemy.remote()`. */
export const publishesDns = Effect.gen(function* () {
  const context = yield* Effect.serviceOption(AlchemyContext);
  const dev = Option.isSome(context) && context.value.dev;
  return !dev || (yield* ProviderModePolicy) === true;
});
