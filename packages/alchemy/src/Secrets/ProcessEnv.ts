import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { envKeys, logLoadedKeys } from "./Log.ts";

/**
 * The process environment as an explicit secrets provider.
 *
 * By default the environment already outranks every provider, so this is
 * only needed together with `automaticallyLoadProcessEnv: false`, to put the environment at
 * a priority of your choosing, typically first so it is a fallback rather
 * than an override:
 *
 * ```ts
 * secrets: {
 *   automaticallyLoadProcessEnv: false,
 *   providers: [Secrets.ProcessEnv(), Secrets.Doppler({ project: "app", config: "prd" })],
 * }
 * ```
 */
export const ProcessEnv = () =>
  ConfigProvider.layerAdd(
    Effect.gen(function* () {
      const environment = ConfigProvider.fromEnv({
        preserveEmptyStrings: true,
      });
      const keys = yield* envKeys(environment);
      // A shell has far too many variables to list; the count is enough.
      yield* logLoadedKeys("the process environment", keys, { names: false });
      return environment;
    }),
    { asPrimary: true },
  );
