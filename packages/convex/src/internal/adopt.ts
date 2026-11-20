import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Whether this resource may take over what someone else made: `adopt(true)`, then `--adopt`. */
export const adoptionAllowed = Effect.fn(function* (fqn: string) {
  const stack = yield* Stack;
  return (
    stack.resources[fqn]?.Adopt ??
    Option.getOrUndefined(yield* Effect.serviceOption(AdoptPolicy)) ??
    (yield* AlchemyContext).adopt
  );
});
