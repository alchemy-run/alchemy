import type { AliasName } from "@alchemy.run/aws/KMS/Alias";
import { Decrypt } from "@alchemy.run/aws/KMS/Decrypt";
import { GenerateDataKey } from "@alchemy.run/aws/KMS/GenerateDataKey";
import type { Key } from "@alchemy.run/aws/KMS/Key";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { fromBase64, KeyWrap, toBase64, VaultError } from "../Vault.ts";

const KMS = "kms.";

const plain = (value: Uint8Array | Redacted.Redacted<Uint8Array>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Wrap each subject's key under an AWS KMS key. KMS makes the subject's key
 * (`GenerateDataKey`) and unwraps it (`Decrypt`), with the subject as the
 * encryption context, so a stored key unwraps only for the subject it was
 * made for. The root key never leaves KMS.
 *
 * Every seal and open is one `Decrypt` call.
 *
 * ### Wrapping keys under KMS
 * **Example:** A KMS key over keys in DynamoDB
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Domain from "@alchemy.run/domain";
 * import * as DomainAWS from "@alchemy.run/domain/AWS";
 * import * as Layer from "effect/Layer";
 *
 * export const Keys = AWS.DynamoDB.Table("VaultKeys", {
 *   partitionKey: "subject",
 *   attributes: { subject: "S" },
 * });
 * export const RootKey = AWS.KMS.Key("VaultRootKey");
 *
 * export const Sealing = Domain.VaultLive.pipe(
 *   Layer.provide(DomainAWS.DynamoKeyStore(Keys)),
 *   Layer.provide(DomainAWS.KmsKeyWrap(RootKey)),
 *   Layer.provide(
 *     Layer.mergeAll(
 *       AWS.DynamoDB.GetItemHttp,
 *       AWS.DynamoDB.PutItemHttp,
 *       AWS.DynamoDB.DeleteItemHttp,
 *       AWS.KMS.GenerateDataKeyHttp,
 *       AWS.KMS.DecryptHttp,
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyWrap
 */
export const KmsKeyWrap = <E = never, R = never>(
  key: Key | AliasName | Effect.Effect<Key, E, R>,
): Layer.Layer<KeyWrap, E, R | GenerateDataKey | Decrypt> =>
  Layer.effect(
    KeyWrap,
    Effect.gen(function* () {
      const root = Effect.isEffect(key) ? yield* key : key;
      const generate = yield* GenerateDataKey(root);
      const decrypt = yield* Decrypt(root);
      const failed = (subject: string) => (cause: { readonly message: string }) =>
        VaultError.make({ subject, reason: cause.message });
      const missing = (subject: string) =>
        VaultError.make({ subject, reason: "KMS returned no key" });
      return {
        make: Effect.fn(function* (subject) {
          const made = yield* generate({
            KeySpec: "AES_256",
            EncryptionContext: { subject },
          }).pipe(Effect.mapError(failed(subject)));
          if (made.Plaintext === undefined || made.CiphertextBlob === undefined) {
            return yield* missing(subject);
          }
          return {
            key: toBase64(plain(made.Plaintext)),
            wrapped: KMS + toBase64(made.CiphertextBlob),
          };
        }),
        unwrap: Effect.fn(function* (subject, wrapped) {
          if (!wrapped.startsWith(KMS)) {
            return yield* VaultError.make({ subject, reason: "its key was not wrapped by KMS" });
          }
          const opened = yield* decrypt({
            CiphertextBlob: fromBase64(wrapped.slice(KMS.length)),
            EncryptionContext: { subject },
          }).pipe(Effect.mapError(failed(subject)));
          if (opened.Plaintext === undefined) return yield* missing(subject);
          return toBase64(plain(opened.Plaintext));
        }),
      };
    }),
  );
