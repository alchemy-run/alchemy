import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import EffectApi from "./src/EffectApi.ts";
import { branch, gateway } from "./src/resources.ts";

export default Alchemy.Stack(
  "NeonAIGatewayExample",
  {
    providers: Neon.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const backend = yield* branch;
    const ai = yield* gateway;
    const api = yield* Neon.Function("NativeAI", {
      branch: backend,
      main: "./src/native.ts",
      env: {
        EXAMPLE_API_KEY: yield* Config.Redacted("NEON_EXAMPLE_API_KEY"),
        AI_MODEL: yield* Config.String("NEON_AI_MODEL"),
        AI_ALLOW_PAID: yield* Config.String("NEON_AI_ALLOW_PAID").pipe(
          Config.withDefault("false"),
        ),
      },
    });
    const effectApi = yield* EffectApi;
    return {
      url: api.url,
      effectApiUrl: effectApi.url,
      gatewayUrl: ai.baseUrl,
    };
  }),
);
