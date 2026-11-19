import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { envValues, readEnvValues, type EnvValueKey } from "../../../../EnvValues.ts";

/**
 * Effect-native container whose `env` holds every {@link envValues} case. It
 * echoes the raw `process.env` value of each key over RPC so the test can
 * assert how the provider stringified them.
 */
export class EnvContainer extends Cloudflare.Container<
  EnvContainer,
  {
    readEnv: () => Effect.Effect<Record<EnvValueKey, string | null>>;
  }
>()("EnvContainer") {}

export default EnvContainer.make(
  {
    main: import.meta.filename,
    image: "oven/bun:latest",
    env: envValues,
  },
  Effect.gen(function* () {
    return {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
      readEnv: () => Effect.sync(() => readEnvValues(process.env)),
    };
  }),
);
