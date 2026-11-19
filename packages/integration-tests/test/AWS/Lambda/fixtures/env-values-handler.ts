import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import path from "pathe";
import { envValues, readEnvValues } from "../../../EnvValues.ts";

const main = path.resolve(import.meta.dirname, "env-values-handler.ts");

/**
 * Lambda whose `env` holds every {@link envValues} case (non-strings and
 * `Redacted` included); it echoes what it reads from `process.env`.
 */
export class EnvValuesFunction extends Lambda.Function<EnvValuesFunction>()("EnvValuesFunction") {}

export const EnvValuesFunctionLive = EnvValuesFunction.make(
  { main, functionUrl: true, env: envValues },
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

export default EnvValuesFunctionLive;
