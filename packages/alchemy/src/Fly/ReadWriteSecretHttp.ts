import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type SecretAuth, makeHttpSecretBinding } from "./SecretHttp.ts";
import { secretReadClient } from "./ReadSecretHttp.ts";
import {
  ReadWriteSecret,
  type ReadWriteSecretClient,
} from "./ReadWriteSecret.ts";
import { secretWriteClient } from "./WriteSecretHttp.ts";

/** Runtime layer for {@link ReadWriteSecret}. */
export const ReadWriteSecretHttp = Layer.effect(
  ReadWriteSecret,
  Effect.suspend(() =>
    makeHttpSecretBinding({
      makeClient: secretReadWriteClient,
    }),
  ),
);

/** Build the combined read + write client over an injectable auth. */
export const secretReadWriteClient = (
  auth: SecretAuth,
  appName: Effect.Effect<string>,
  secretName: Effect.Effect<string>,
): ReadWriteSecretClient => ({
  ...secretReadClient(auth, appName, secretName),
  ...secretWriteClient(auth, appName, secretName),
});
