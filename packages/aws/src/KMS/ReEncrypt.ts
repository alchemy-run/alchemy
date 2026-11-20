import * as kms from "@distilled.cloud/aws/kms";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";
import { keyLabel, keyPolicyStatement, type KeyLike } from "./KeyBinding.ts";

export interface ReEncryptRequest extends Omit<
  kms.ReEncryptRequest,
  "DestinationKeyId" | "SourceKeyId"
> {}

/**
 * Runtime binding for `kms:ReEncrypt`.
 *
 * Re-encrypts a ciphertext under a new key (or a new encryption context)
 * entirely inside KMS — the plaintext never leaves the service. Bind the
 * destination KMS {@link Key} (or `alias/...` name), and optionally the
 * source key when migrating ciphertexts between keys:
 *
 * - `ReEncrypt(key)` — same-key re-encryption (e.g. rotating the encryption
 *   context). Grants `kms:ReEncryptFrom` + `kms:ReEncryptTo` on the key.
 * - `ReEncrypt(destination, source)` — cross-key migration. Grants
 *   `kms:ReEncryptTo` on the destination and `kms:ReEncryptFrom` on the
 *   source, and pins `SourceKeyId` in every request.
 *
 * ### Re-Encryption
 * **Example:** Rotate the Encryption Context In Place
 * ```typescript
 * const reEncrypt = yield* AWS.KMS.ReEncrypt(key);
 *
 * const { CiphertextBlob } = yield* reEncrypt({
 *   CiphertextBlob: ciphertext,
 *   SourceEncryptionContext: { tenant: "alpha" },
 *   DestinationEncryptionContext: { tenant: "beta" },
 * });
 * ```
 *
 * **Example:** Migrate Ciphertexts to a New Key
 * ```typescript
 * const reEncrypt = yield* AWS.KMS.ReEncrypt(newKey, oldKey);
 *
 * const { CiphertextBlob } = yield* reEncrypt({
 *   CiphertextBlob: legacyCiphertext,
 * });
 * ```
 *
 * @binding
 */
export interface ReEncrypt extends Binding.Service<
  ReEncrypt,
  "AWS.KMS.ReEncrypt",
  (
    destination: Key | AliasName,
    source?: Key | AliasName,
  ) => Effect.Effect<
    (request: ReEncryptRequest) => Effect.Effect<kms.ReEncryptResponse, kms.ReEncryptError>
  >
> {}

export const ReEncrypt = Binding.Service<ReEncrypt>("AWS.KMS.ReEncrypt");

/**
 * Bespoke (not scaffolded): ReEncrypt spans two keys — `kms:ReEncryptTo` on
 * the destination and `kms:ReEncryptFrom` on the source — and injects
 * `DestinationKeyId` (plus `SourceKeyId` when a source key is bound).
 */
export const ReEncryptHttp = Layer.effect(
  ReEncrypt,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const reEncrypt = yield* AWSBindings.withCredentials(kms.reEncrypt);

    return Effect.fn(function* (destination: KeyLike, source?: KeyLike) {
      const from = source ?? destination;
      const DestinationKeyId =
        typeof destination === "string"
          ? Effect.succeed<string>(destination)
          : yield* destination.keyId;
      const SourceKeyId =
        typeof from === "string" ? Effect.succeed<string>(from) : yield* from.keyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.KMS.ReEncrypt(${destination}, ${from})`({
          policyStatements:
            source === undefined
              ? [keyPolicyStatement(["kms:ReEncryptFrom", "kms:ReEncryptTo"], destination)]
              : [
                  keyPolicyStatement("kms:ReEncryptTo", destination),
                  keyPolicyStatement("kms:ReEncryptFrom", from),
                ],
        });
      }
      return Effect.fn(`AWS.KMS.ReEncrypt(${keyLabel(destination)})`)(function* (
        request: ReEncryptRequest,
      ) {
        const destinationKeyId = yield* DestinationKeyId;
        // Always pin the source key (AWS best practice for symmetric
        // ciphertexts) — and required for alias-bound IAM, where the
        // `kms:RequestAlias` condition only matches when the alias appears
        // in the request.
        const sourceKeyId = yield* SourceKeyId;
        return yield* reEncrypt({
          ...request,
          SourceKeyId: sourceKeyId,
          DestinationKeyId: destinationKeyId,
        });
      });
    });
  }),
);
