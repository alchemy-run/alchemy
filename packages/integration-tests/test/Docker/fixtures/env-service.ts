import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { envValues, readEnvValues } from "../../EnvValues.ts";

/** Fixed host port published through the swarm ingress. */
export const ENV_EXTERNAL_PORT = 43123;

/**
 * Effect-native swarm service whose `env` holds every {@link envValues} case.
 * Every request echoes the raw `process.env` value of each key.
 */
export default class EnvService extends Docker.Service<EnvService>()(
  "DockerEnvService",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ external: ENV_EXTERNAL_PORT, internal: 3000 }],
    replicas: 1,
    env: envValues,
  },
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
