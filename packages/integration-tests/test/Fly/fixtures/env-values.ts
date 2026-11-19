import * as Fly from "@alchemy.run/fly";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { bindEnvOutputs } from "../../EnvBoundOutputs.ts";
import { envValues, readEnvValues } from "../../EnvValues.ts";

/**
 * Service deployed with every {@link envValues} case. `/env` echoes the raw
 * `process.env` value of each key; `/bound` echoes Outputs bound in init.
 */
export default class EnvValuesApi extends Fly.Service<EnvValuesApi>()(
  "EnvValuesApi",
  {
    main: import.meta.url,
    region: "iad",
    port: 3000,
    env: envValues,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const random = yield* Random("EnvBoundRandom", { bytes: 4 });
    const bound = yield* bindEnvOutputs(random.text);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/env")) {
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
          return yield* HttpServerResponse.json(
            yield* Effect.sync(() => readEnvValues(process.env)),
          );
        }
        if (request.url.startsWith("/bound")) {
          return yield* HttpServerResponse.json(yield* bound);
        }
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }),
) {}
