import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";

export default Alchemy.Stack(
  "neon-function",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const project = yield* Neon.Project("App", { region: "aws-us-east-2" });
    const api = yield* Neon.Function("Api", {
      project,
      main: new URL("./api.ts", import.meta.url).href,
      env: {
        LOG_LEVEL: "info",
        APP_TOKEN: yield* Config.Redacted("APP_TOKEN"),
      },
    });
    return { url: api.url };
  }),
);
