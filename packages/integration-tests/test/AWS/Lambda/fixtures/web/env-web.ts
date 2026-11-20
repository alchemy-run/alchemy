import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { echoEnv, envValuesWithout } from "../../../../EnvValues.ts";

/** The WebFunction API rejects an empty env value, so it skips that case. */
export const webEnv = envValuesWithout("ENV_EMPTY");

/** WebFunction whose `env` holds the {@link webEnv} cases; it echoes `process.env`. */
export class EnvWebFunction extends Lambda.WebFunction<Lambda.WebFunction>()("EnvWebFunction") {}

export default EnvWebFunction.make(
  { main: import.meta.url, authType: "ApplicationManaged", env: webEnv.values },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* echoEnv);
      }).pipe(Effect.orDie),
    };
  }),
);
