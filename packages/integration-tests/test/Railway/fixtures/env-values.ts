import * as Railway from "@alchemy.run/railway";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { bindEnvOutputs, echoEnv, envValues } from "../../EnvValues.ts";
import { Partition, Site } from "./suite-env.ts";

/**
 * Service deployed with every {@link envValues} case. It echoes the raw
 * `process.env` value of each, and the Outputs bound in init.
 */
export default class EnvValuesApi extends Railway.Service<EnvValuesApi>()(
  "EnvValuesApi",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
    port: 3000,
    env: envValues,
  },
  Effect.gen(function* () {
    const random = yield* Random("EnvBoundRandom", { bytes: 4 });
    const bound = yield* bindEnvOutputs(random.text);
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({ env: yield* echoEnv, bound: yield* bound });
      }).pipe(Effect.orDie),
    };
  }),
) {}
