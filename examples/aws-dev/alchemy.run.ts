import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import ApiFunction from "./src/ApiFunction.ts";

export default Alchemy.Stack(
  "aws-dev",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* ApiFunction;
    return {
      api: api.functionUrl,
    };
  }),
);
