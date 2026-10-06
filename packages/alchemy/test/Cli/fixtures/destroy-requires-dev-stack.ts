import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Stands in for a declaration that calls a cloud API while the stack is
 * evaluated (e.g. `AWS.EC2.Network`): evaluating it outside dev mode fails,
 * as it would without credentials.
 */
export default Alchemy.Stack(
  "DestroyRequiresDev",
  { providers: Layer.empty, state: Alchemy.localState() },
  Effect.gen(function* () {
    const context = yield* AlchemyContext;
    if (!context.dev) {
      return yield* Effect.die("stack evaluated in live mode");
    }
  }),
);
