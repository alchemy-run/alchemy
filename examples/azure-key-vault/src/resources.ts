import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * The vault. It authorizes data-plane calls with Azure RBAC (the default),
 * so each binding assigns a role on one key or secret. A 7-day soft-delete
 * retention keeps deleted keys and secrets recoverable for a week; destroy
 * purges the vault so its name is free again right away.
 */
export const Vault = Azure.KeyVault.Vault("Vault", { softDeleteRetentionInDays: 7 });

/** The first API key: 32 random bytes, generated once and kept in state. */
export const InitialApiKey = Alchemy.Random("InitialApiKey");

/**
 * The API key callers send in `x-api-key`. The stack writes the first
 * version; `POST /rotate` writes new ones, and the API always checks
 * against the latest version.
 */
export const ApiKey = Effect.gen(function* () {
  const vault = yield* Vault;
  const initial = yield* InitialApiKey;
  return yield* Azure.KeyVault.Secret("ApiKey", {
    vault: vault.vaultName,
    value: initial.text,
    contentType: "text/plain",
  });
});

/** RSA key that encrypts and decrypts data (`RSA-OAEP-256`). */
export const DataKey = Effect.gen(function* () {
  const vault = yield* Vault;
  return yield* Azure.KeyVault.Key("DataKey", {
    vault: vault.vaultName,
    kty: "RSA",
    keySize: 2048,
    keyOps: ["encrypt", "decrypt"],
  });
});

/** Elliptic-curve key that signs and verifies messages (`ES256`). */
export const SigningKey = Effect.gen(function* () {
  const vault = yield* Vault;
  return yield* Azure.KeyVault.Key("SigningKey", {
    vault: vault.vaultName,
    kty: "EC",
    curveName: "P-256",
    keyOps: ["sign", "verify"],
  });
});

/** Largest plaintext `RSA-OAEP-256` accepts with a 2048-bit key, in bytes. */
export const MAX_PLAINTEXT_BYTES = 190;
