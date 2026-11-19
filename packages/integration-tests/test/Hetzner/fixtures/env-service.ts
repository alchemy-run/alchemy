import * as Hetzner from "@alchemy.run/hetzner";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import path from "pathe";
import { envValues, readEnvValues } from "../../EnvValues.ts";

export const ENV_PROGRAM_PORT = 3000;
export const ENV_CONTAINER_PORT = 3001;

/** Docker build context for the container-mode Service. */
export const envContainerContext = path.resolve(import.meta.dirname, "env-container");

export const EnvBox = Hetzner.Server("EnvBox", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "nbg1",
});

/**
 * Hosted program (systemd `EnvironmentFile` mode) whose `env` holds every
 * case in {@link envValues}. It echoes them as read from `process.env`.
 */
export default class EnvService extends Hetzner.Service<EnvService>()(
  "EnvService",
  {
    server: EnvBox,
    main: import.meta.url,
    port: ENV_PROGRAM_PORT,
    env: envValues,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
        const env = yield* Effect.sync(() => readEnvValues(process.env));
        return yield* HttpServerResponse.json(env);
      }).pipe(Effect.orDie),
    };
  }),
) {}
