import * as Effect from "effect/Effect";
import { Random } from "../../Random.ts";
import * as Secret from "../SecretsStore/Secret.ts";
import { Store as SecretsStore } from "../SecretsStore/SecretsStore.ts";
import {
  StateStoreWorkerName,
  authTokenSecretName,
  encryptionKeySecretName,
} from "./Names.ts";

/**
 * The account-wide Secrets Store that backs every secret used by the
 * state store worker. `SecretsStore` adopts the single store that
 * already exists on the account, or creates one if none exists.
 */
export const Store = SecretsStore("StateStoreSecrets");

/**
 * The randomly generated bearer token value. Generated once on create
 * and persisted in alchemy state, so subsequent deploys keep the same
 * value unless the resource is replaced.
 */
export const TokenValue = Random("StateStoreAuthTokenValue");

/**
 * The name of the secret in the Cloudflare Secrets Store that contains the
 * bearer token for the *default* state store. Named stores
 * (`Cloudflare.state({ workerName })`) suffix this with the worker name —
 * see {@link authTokenSecretName}.
 */
export const AuthTokenSecretName = "AlchemyStateStoreToken" as const;

/**
 * The bearer token used to authenticate every request to the state
 * store worker. The value comes from {@link TokenValue} and lives in
 * the account-wide Cloudflare Secrets Store so it can be bound into
 * the worker without bundling the raw string.
 *
 * The secret's *name* is derived from {@link StateStoreWorkerName} so
 * each named state store owns its own bearer token; the logical id
 * stays fixed (the worker reads the binding by logical id).
 */
export const AuthToken = Effect.gen(function* () {
  const store = yield* Store;
  const random = yield* TokenValue;
  const workerName = yield* StateStoreWorkerName;
  return yield* Secret.Secret(AuthTokenSecretName, {
    name: authTokenSecretName(workerName),
    store,
    value: random.text,
  });
});

/**
 * A 32-byte (256-bit) random value, hex-encoded, that seeds the
 * AES-CTR key used to encrypt resource state at rest. Generated once
 * and persisted, so the ciphertext stored by the Durable Object can
 * always be decrypted by subsequent worker boots.
 */
export const EncryptionKeyValue = Random("StateStoreEncryptionKeyValue", {
  bytes: 32,
});

/**
 * The name of the encryption-key secret for the *default* state store.
 * Named stores suffix this with the worker name — see
 * {@link encryptionKeySecretName}.
 */
export const EncryptionKeySecretName =
  "AlchemyStateStoreEncryptionKey" as const;

/**
 * The encryption key secret. The raw hex-encoded bytes live inside
 * Cloudflare's Secrets Store; the Durable Object binds to it at
 * runtime to derive an AES-CTR `CryptoKey` via Web Crypto's
 * `subtle.importKey`.
 *
 * Like {@link AuthToken}, the secret name is per-store while the
 * logical id stays fixed, so each named store encrypts its state with
 * its own key.
 */
export const EncryptionKey = Effect.gen(function* () {
  const store = yield* Store;
  const random = yield* EncryptionKeyValue;
  const workerName = yield* StateStoreWorkerName;
  return yield* Secret.Secret("StateStoreEncryptionKey", {
    name: encryptionKeySecretName(workerName),
    store,
    value: random.text,
  });
});
