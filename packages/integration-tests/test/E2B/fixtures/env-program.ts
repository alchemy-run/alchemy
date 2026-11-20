import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { echoEnv, envValues } from "../../EnvValues.ts";

/**
 * An Effect program template deployed with every {@link envValues} case;
 * `fetch` echoes the raw `process.env` value of each. Deployed from
 * {@link ../Env.test.ts}.
 */
export default class EnvTemplate extends E2B.Template<EnvTemplate>()(
  "EnvTemplate",
  { main: import.meta.url, port: 3000, env: envValues },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* echoEnv);
    }),
  }),
) {}
