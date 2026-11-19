import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { envValues, readEnvValues } from "../../../EnvValues.ts";
import { PROGRAM_PORT } from "./shared.ts";

/**
 * A sandbox program deployed with every {@link envValues} case; `fetch`
 * echoes the raw `process.env` value of each. Deployed from
 * {@link ../../Env.test.ts}.
 */
export default class EnvAgent extends Daytona.Sandbox<EnvAgent>()(
  "EnvAgent",
  { main: import.meta.url, port: PROGRAM_PORT, public: true, env: envValues },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
      const env = yield* Effect.sync(() => readEnvValues(process.env));
      return yield* HttpServerResponse.json(env);
    }),
  }),
) {}
