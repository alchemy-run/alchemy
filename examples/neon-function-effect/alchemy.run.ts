import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import Api from "./Api.ts";

export default Alchemy.Stack(
  "neon-function-effect",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
