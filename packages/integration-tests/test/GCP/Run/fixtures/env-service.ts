import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { echoEnv, envValues } from "../../../EnvValues.ts";

/**
 * Effect-native Cloud Run Service deployed with every {@link envValues}
 * case; `fetch` echoes the raw `process.env` value of each.
 * Deployed from {@link ../Env.test.ts}.
 */
export default class EnvService extends GCP.Function<EnvService>()(
  "EnvService",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
    env: envValues,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* echoEnv);
      }),
    };
  }),
) {}
