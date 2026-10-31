import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Mode from "./Mode.ts";
import * as State from "./State.ts";

/**
 * `alchemy dev` trusts the Portless CA, so local Workers and the commands
 * `Command.Dev` and `Portless.Dev` start accept the proxy's certificates. The
 * file is created when the proxy first starts, so it may not exist yet; it
 * lives in the state directory `PORTLESS_STATE_DIR` names, as it does for the
 * proxy. With `PORTLESS=0` there is no proxy and no CA.
 */
export const devTrust = Effect.gen(function* () {
  if (yield* Mode.disabled) return [];
  const path = yield* Path.Path;
  const { stateDirectory } = yield* State.settings;
  return [path.join(stateDirectory, "ca.pem")];
}).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
