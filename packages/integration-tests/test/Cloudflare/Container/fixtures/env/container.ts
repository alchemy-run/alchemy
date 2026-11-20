import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { echoEnv, type EnvValueKey, envValues } from "../../../../EnvValues.ts";

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
      readEnv: () => echoEnv,
    };
  }),
);
