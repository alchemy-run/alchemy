import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/** Where the API key lives in the Vault. */
export const API_KEY_PATH = "api/key";

/**
 * A Secrets Manager instance. Both a deploy and each host with a binding talk to its Vault
 * API, and a Function has no fixed egress address, so this one lets everything reach it.
 * Vault still asks for a login. Use a narrower `acls` when your hosts have known addresses.
 */
export const Vault = Stackit.SecretsManager.Instance("Vault", {
  acls: ["0.0.0.0/0"],
});

/** The value callers have to present. Alchemy generates it once and keeps it in state. */
export const ApiKeyValue = Alchemy.Random("ApiKeyValue", { bytes: 24 });

/** The API key as a secret. A deploy writes it, and the function reads it at runtime. */
export const ApiKey = Effect.gen(function* () {
  const vault = yield* Vault;
  const value = yield* ApiKeyValue;
  return yield* Stackit.SecretsManager.Secret("ApiKey", {
    instanceId: vault.instanceId,
    path: API_KEY_PATH,
    data: { value: value.text },
  });
});

export const Ring = Stackit.KMS.KeyRing("Ring", {});

/** The key that encrypts and decrypts. Its material never leaves KMS. */
export const DataKey = Ring.pipe(
  Effect.flatMap((ring) =>
    Stackit.KMS.Key("DataKey", {
      keyRingId: ring.keyRingId,
      algorithm: "aes_256_gcm",
      purpose: "symmetric_encrypt_decrypt",
    }),
  ),
);
