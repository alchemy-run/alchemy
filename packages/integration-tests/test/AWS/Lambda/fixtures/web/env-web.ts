import * as Lambda from "@alchemy.run/aws/Lambda";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { bindEnvOutputs, echoEnv, envValuesWithout } from "../../../../EnvValues.ts";

/** The WebFunction API rejects an empty env value, so it skips that case. */
export const webEnv = envValuesWithout("ENV_EMPTY");

/**
 * WebFunction whose `env` holds the {@link webEnv} cases; it echoes
 * `process.env`, and two values bound in Construction, one `Redacted`.
 */
export class EnvWebFunction extends Lambda.WebFunction<Lambda.WebFunction>()("EnvWebFunction") {}

export default EnvWebFunction.make(
  { main: import.meta.url, authType: "ApplicationManaged", env: webEnv.values },
  Effect.gen(function* () {
    const random = yield* Random("EnvWebBoundRandom", { bytes: 4 });
    const bound = yield* bindEnvOutputs(random.text);
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({ values: yield* echoEnv, bound: yield* bound });
      }).pipe(Effect.orDie),
    };
  }),
);
