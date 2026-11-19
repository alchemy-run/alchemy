import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { envValuesWithout, readEnvValues } from "../../../../EnvValues.ts";

/** The WebFunction API rejects an empty env value, so it skips that case. */
export const webEnv = envValuesWithout("ENV_EMPTY");

/** WebFunction whose `env` holds the {@link webEnv} cases; it echoes `process.env`. */
export class EnvWebFunction extends Lambda.WebFunction<Lambda.WebFunction>()("EnvWebFunction") {}

export default EnvWebFunction.make(
  { main: import.meta.url, authType: "ApplicationManaged", env: webEnv.values },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
        const env = yield* Effect.sync(() => readEnvValues(process.env));
        return yield* HttpServerResponse.json(env);
      }).pipe(Effect.orDie),
    };
  }),
);
