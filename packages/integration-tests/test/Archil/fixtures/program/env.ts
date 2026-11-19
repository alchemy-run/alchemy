import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { envValues, readEnvValues } from "../../../EnvValues.ts";

/**
 * A sandbox program deployed with every {@link envValues} case; `fetch`
 * echoes the raw `process.env` value of each. Deployed from
 * {@link ../../Env.test.ts}.
 */
export default class EnvApi extends Archil.Sandbox<EnvApi>()(
  "EnvApi",
  {
    main: import.meta.url,
    port: 3003,
    idleTtlSeconds: 300,
    // `env` is typed `string | Redacted<string>`, narrower than what the
    // other hosts accept; the cases still go through as-is.
    env: envValues as Record<string, any>,
  },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
      const env = yield* Effect.sync(() => readEnvValues(process.env));
      return yield* HttpServerResponse.json(env);
    }),
  }),
) {}
