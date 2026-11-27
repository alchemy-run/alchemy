import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { bindEnvOutputs, echoEnv, envValues } from "../../../EnvValues.ts";

/**
 * Effect-native Cloud Run Service deployed with every {@link envValues}
 * case; `fetch` echoes the raw `process.env` value of each (`values`), and
 * two values bound in Init through the runtime context, one of them
 * `Redacted` (`bound`), the way a Rivet Durable Object binds its token.
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
    // Any upstream resource does: the bound Outputs only need to resolve at deploy.
    const topic = yield* GCP.PubSub.Topic("EnvBoundTopic", {});
    const bound = yield* bindEnvOutputs(topic.name);
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          values: yield* echoEnv,
          bound: yield* bound,
        });
      }),
    };
  }),
) {}
