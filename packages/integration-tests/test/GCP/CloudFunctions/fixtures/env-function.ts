import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { envValues, readEnvValues } from "../../../EnvValues.ts";

/**
 * Effect-native Cloud Function deployed with every {@link envValues} case;
 * `fetch` echoes the raw `process.env` value of each.
 * Deployed from {@link ../Env.test.ts}.
 */
export default class EnvFunction extends GCP.CloudFunctions.Function<EnvFunction>()(
  "EnvFunction",
  { main: import.meta.url, location: "us-central1", env: envValues },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
        const env = yield* Effect.sync(() => readEnvValues(process.env));
        return yield* HttpServerResponse.json(env);
      }),
    };
  }),
) {}
