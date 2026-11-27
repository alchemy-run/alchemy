import type { CryptoKey } from "@alchemy.run/gcp/KMS/CryptoKey";
import { Decrypt } from "@alchemy.run/gcp/KMS/Decrypt";
import { Encrypt } from "@alchemy.run/gcp/KMS/Encrypt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type IntermediateKeyOptions,
  intermediateKeyWrap,
  isIntermediate,
  KeyWrap,
  newKey,
  type WrappedKey,
} from "../KeyWrap.ts";
import { VaultError } from "../VaultError.ts";

const KMS = "gkms.";

/** Options for {@link KmsKeyWrap}. */
export interface KmsKeyWrapOptions {
  /**
   * Call Cloud KMS once per intermediate key instead of once per seal and
   * open. Each process makes an intermediate key, has KMS wrap it, keeps it
   * in memory for `keep`, and wraps subject keys under it locally.
   *
   * It trades cost for exposure: an intermediate key is in the process's
   * memory, KMS logs one call per intermediate key rather than one per
   * subject, and a process cut off from KMS reads on for up to `keep`.
   * Shredding is unchanged: each subject keeps a key of its own.
   *
   * @default undefined (every seal and open is one KMS call)
   */
  readonly intermediateKey?: IntermediateKeyOptions;
}

/** What an intermediate key is bound to: it belongs to no one subject. */
const INTERMEDIATE_PURPOSE = "alchemy-domain-vault-intermediate-key";

// KMS takes its additional authenticated data as base64.
const aad = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * Wrap each subject's key under a Cloud KMS key. KMS encrypts and decrypts
 * the subject's key with the subject as additional authenticated data, so a
 * stored key unwraps only for the subject it was made for. The root key
 * never leaves KMS.
 *
 * Every seal and open is one `Decrypt` call.
 *
 * ### Wrapping keys under Cloud KMS
 * **Example:** A Cloud KMS key over keys in Firestore
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as DomainGCP from "@alchemy.run/domain/GCP";
 * import * as GCP from "@alchemy.run/gcp";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export const Keys = GCP.Firestore.Database("VaultKeys", {
 *   location: "us-central1",
 *   type: "FIRESTORE_NATIVE",
 * });
 * export const RootKey = Effect.gen(function* () {
 *   const keyRing = yield* GCP.KMS.KeyRing("Vault", { location: "us-central1" });
 *   return yield* GCP.KMS.CryptoKey("VaultRootKey", { keyRing: keyRing.name });
 * });
 *
 * export const Sealing = Domain.VaultLive.pipe(
 *   Layer.provide(DomainGCP.FirestoreKeyStore(Keys)),
 *   Layer.provide(DomainGCP.KmsKeyWrap(RootKey)),
 *   Layer.provide(
 *     Layer.mergeAll(
 *       GCP.Firestore.GetDocumentHttp,
 *       GCP.Firestore.PatchDocumentHttp,
 *       GCP.Firestore.DeleteDocumentHttp,
 *       GCP.KMS.EncryptHttp,
 *       GCP.KMS.DecryptHttp,
 *     ),
 *   ),
 * );
 * ```
 *
 * ### Calling Cloud KMS less often
 * `intermediateKey` has each process keep one intermediate key in memory
 * and wrap subject keys under it locally, so Cloud KMS is called once per
 * intermediate key instead of once per seal and open. The intermediate key
 * is in the process's memory, Cloud KMS no longer logs each subject's access,
 * and a process cut off from Cloud KMS reads on for up to `keep`. Shredding is
 * unchanged.
 *
 * **Example:** One Cloud KMS call per process every five minutes
 * ```typescript
 * DomainGCP.KmsKeyWrap(RootKey, { intermediateKey: { keep: "5 minutes" } });
 * ```
 *
 * @layer
 * @provides Domain.KeyWrap
 */
export const KmsKeyWrap = <E = never, R = never>(
  key: CryptoKey | Effect.Effect<CryptoKey, E, R>,
  options: KmsKeyWrapOptions = {},
): Layer.Layer<KeyWrap, E, R | Encrypt | Decrypt> =>
  Layer.effect(
    KeyWrap,
    Effect.gen(function* () {
      const root = Effect.isEffect(key) ? yield* key : key;
      const encrypt = yield* Encrypt(root);
      const decrypt = yield* Decrypt(root);
      const failed = (subject: string) => (cause: { readonly message: string }) =>
        VaultError.make({ subject, reason: cause.message });
      const missing = (subject: string) =>
        VaultError.make({ subject, reason: "KMS returned no key" });
      // A new key, and what KMS wrapped it as, bound to `binding`.
      const makeUnder = Effect.fn(function* (subject: string, binding: string) {
        const made = yield* newKey;
        const sealed = yield* encrypt({
          plaintext: made,
          additionalAuthenticatedData: aad(binding),
        }).pipe(Effect.mapError(failed(subject)));
        if (sealed.ciphertext === undefined) return yield* missing(subject);
        return { key: made, wrapped: sealed.ciphertext };
      });
      const unwrapUnder = Effect.fn(function* (subject: string, wrapped: string, binding: string) {
        const opened = yield* decrypt({
          ciphertext: wrapped,
          additionalAuthenticatedData: aad(binding),
        }).pipe(Effect.mapError(failed(subject)));
        if (opened.plaintext === undefined) return yield* missing(subject);
        return opened.plaintext;
      });
      type Calls = {
        readonly make: (subject: string) => Effect.Effect<WrappedKey, VaultError>;
        readonly unwrap: (subject: string, wrapped: string) => Effect.Effect<string, VaultError>;
      };
      // The bindings' calls run inside the model's runtime.
      const makeKey = makeUnder as unknown as (
        subject: string,
        binding: string,
      ) => Effect.Effect<WrappedKey, VaultError>;
      const unwrapKey = unwrapUnder as unknown as (
        subject: string,
        wrapped: string,
        binding: string,
      ) => Effect.Effect<string, VaultError>;
      const direct: Calls = {
        make: Effect.fn(function* (subject) {
          const made = yield* makeKey(subject, subject);
          return { key: made.key, wrapped: KMS + made.wrapped };
        }),
        unwrap: Effect.fn(function* (subject, wrapped) {
          // A key wrapped under an intermediate key still opens with the option off.
          if (isIntermediate(wrapped)) return yield* intermediate.unwrap(subject, wrapped);
          if (!wrapped.startsWith(KMS)) {
            return yield* VaultError.make({
              subject,
              reason: "its key was not wrapped by Cloud KMS",
            });
          }
          return yield* unwrapKey(subject, wrapped.slice(KMS.length), subject);
        }),
      };
      const intermediate: Calls = intermediateKeyWrap({
        // With the option off, an intermediate key is only ever read: keep none.
        keep: options.intermediateKey?.keep ?? 0,
        // Base64 with no `.`: it is a field of what is stored.
        make: (subject) => makeKey(subject, INTERMEDIATE_PURPOSE),
        unwrap: (subject, wrapped) => unwrapKey(subject, wrapped, INTERMEDIATE_PURPOSE),
        direct: direct.unwrap,
      });
      return options.intermediateKey === undefined ? direct : intermediate;
    }),
  );
