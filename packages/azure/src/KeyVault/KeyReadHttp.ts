import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGetKeyClient } from "./GetKeyHttp.ts";
import { makeGetKeyRotationPolicyClient } from "./GetKeyRotationPolicyHttp.ts";
import { makeGetKeyVersionsClient } from "./GetKeyVersionsHttp.ts";
import type { Key } from "./Key.ts";
import { KeyRead, type ReadKeyClient } from "./KeyRead.ts";

/** Builds the {@link KeyRead} client for one key from the per-operation bindings. */
export const makeKeyReadClient = Effect.gen(function* () {
  const getKey = yield* makeGetKeyClient;
  const getKeyVersions = yield* makeGetKeyVersionsClient;
  const getKeyRotationPolicy = yield* makeGetKeyRotationPolicyClient;
  return Effect.fn(function* (key: Key) {
    const get = yield* getKey(key);
    const versions = yield* getKeyVersions(key);
    const rotationPolicy = yield* getKeyRotationPolicy(key);
    return {
      get: (version?: string) => get({ keyVersion: version ?? "" }),
      versions: (options?: { maxresults?: number; nextLink?: string }) => versions(options),
      rotationPolicy: () => rotationPolicy(),
    } satisfies ReadKeyClient;
  });
});

/**
 * Implementation of {@link KeyRead} over the distilled `keyvault-keys` data
 * plane. Assigns custom roles with only
 * `Microsoft.KeyVault/vaults/keys/read` and
 * `Microsoft.KeyVault/vaults/keyrotationpolicies/read` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.KeyRead
 */
export const KeyReadHttp = Layer.effect(KeyRead, makeKeyReadClient);
