import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import LiveFunction from "./src/LiveFunction.ts";

/** Live Lambda e2e fixture — see src/LiveFunction.ts. */
export default Alchemy.Stack(
  "LiveE2E",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const func = yield* LiveFunction;
    return { url: func.functionUrl.as<string>() };
  }),
);
