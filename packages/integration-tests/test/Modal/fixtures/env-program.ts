import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { envValues, readEnvValues } from "../../EnvValues.ts";
import { Coder } from "./resources.ts";

/**
 * A sandbox program deployed with every {@link envValues} case; `fetch`
 * echoes the raw `process.env` value of each. Started by
 * {@link ./env-function.ts}.
 */
export default class EnvAgent extends Modal.Sandbox<EnvAgent>()(
  "EnvAgent",
  { main: import.meta.url, app: Coder, env: envValues },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
      const env = yield* Effect.sync(() => readEnvValues(process.env));
      return yield* HttpServerResponse.json(env);
    }),
  }),
) {}
