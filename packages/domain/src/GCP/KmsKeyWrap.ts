import type { CryptoKey } from "@alchemy.run/gcp/KMS/CryptoKey";
import { Decrypt } from "@alchemy.run/gcp/KMS/Decrypt";
import { Encrypt } from "@alchemy.run/gcp/KMS/Encrypt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KeyWrap, newKey, VaultError } from "../Vault.ts";

const KMS = "gkms.";

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
 * @layer
 * @provides Domain.KeyWrap
 */
export const KmsKeyWrap = <E = never, R = never>(
  key: CryptoKey | Effect.Effect<CryptoKey, E, R>,
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
      // KMS takes its additional authenticated data as base64.
      const aad = (subject: string) => {
        let text = "";
        for (const byte of new TextEncoder().encode(subject)) text += String.fromCharCode(byte);
        return btoa(text);
      };
      return {
        make: Effect.fn(function* (subject) {
          const made = yield* newKey;
          const sealed = yield* encrypt({
            plaintext: made,
            additionalAuthenticatedData: aad(subject),
          }).pipe(Effect.mapError(failed(subject)));
          if (sealed.ciphertext === undefined) return yield* missing(subject);
          return { key: made, wrapped: KMS + sealed.ciphertext };
        }),
        unwrap: Effect.fn(function* (subject, wrapped) {
          if (!wrapped.startsWith(KMS)) {
            return yield* VaultError.make({
              subject,
              reason: "its key was not wrapped by Cloud KMS",
            });
          }
          const opened = yield* decrypt({
            ciphertext: wrapped.slice(KMS.length),
            additionalAuthenticatedData: aad(subject),
          }).pipe(Effect.mapError(failed(subject)));
          if (opened.plaintext === undefined) return yield* missing(subject);
          return opened.plaintext;
        }),
      };
    }),
  );
