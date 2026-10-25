import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCreateKeyClient } from "./CreateKeyHttp.ts";
import { makeDeleteKeyClient } from "./DeleteKeyHttp.ts";
import { makeImportKeyClient } from "./ImportKeyHttp.ts";
import type { Key } from "./Key.ts";
import { KeyWrite, type WriteKeyClient } from "./KeyWrite.ts";
import { makeRotateKeyClient } from "./RotateKeyHttp.ts";
import { makeUpdateKeyClient } from "./UpdateKeyHttp.ts";
import { makeUpdateKeyRotationPolicyClient } from "./UpdateKeyRotationPolicyHttp.ts";

/** Builds the {@link KeyWrite} client for one key from the per-operation bindings. */
export const makeKeyWriteClient = Effect.gen(function* () {
  const createKey = yield* makeCreateKeyClient;
  const importKey = yield* makeImportKeyClient;
  const updateKey = yield* makeUpdateKeyClient;
  const rotateKey = yield* makeRotateKeyClient;
  const updateKeyRotationPolicy = yield* makeUpdateKeyRotationPolicyClient;
  const deleteKey = yield* makeDeleteKeyClient;
  return Effect.fn(function* (key: Key) {
    const create = yield* createKey(key);
    const importVersion = yield* importKey(key);
    const update = yield* updateKey(key);
    const rotate = yield* rotateKey(key);
    const setRotationPolicy = yield* updateKeyRotationPolicy(key);
    const remove = yield* deleteKey(key);
    return {
      create: (request) => create(request),
      import: (request) => importVersion(request),
      update: (request) => update(request),
      rotate: () => rotate(),
      setRotationPolicy: (request) => setRotationPolicy(request),
      delete: () => remove(),
    } satisfies WriteKeyClient;
  });
});

/**
 * Implementation of {@link KeyWrite} over the distilled `keyvault-keys`
 * data plane. Assigns custom roles with only `keys/create/action`,
 * `keys/import/action`, `keys/update/action`, `keys/rotate/action`,
 * `keyrotationpolicies/write`, and `keys/delete` on the key.
 *
 * @layer
 * @provides Azure.KeyVault.KeyWrite
 */
export const KeyWriteHttp = Layer.effect(KeyWrite, makeKeyWriteClient);
