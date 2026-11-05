import * as kms from "@distilled.cloud/aws/kms";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AliasName } from "./Alias.ts";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface GenerateDataKeyWithoutPlaintextRequest extends Omit<
  kms.GenerateDataKeyWithoutPlaintextRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:GenerateDataKeyWithoutPlaintext`.
 *
 * Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
 * pre-existing key) to get a callable that automatically injects the
 * `KeyId`. Returns ONLY the encrypted copy of a fresh data key — use it in
 * the component that provisions envelope keys but must never see key
 * material; the consumer decrypts the blob later with the `Decrypt` binding.
 *
 * ### Envelope Encryption
 * **Example:** Provision a Data Key Without Seeing It
 * ```typescript
 * const generateDataKeyWithoutPlaintext =
 *   yield* AWS.KMS.GenerateDataKeyWithoutPlaintext(key);
 *
 * const { CiphertextBlob } = yield* generateDataKeyWithoutPlaintext({
 *   KeySpec: "AES_256",
 * });
 * // store CiphertextBlob next to the data; no plaintext ever existed here
 * ```
 *
 * ### Pre-Existing Keys
 * **Example:** Bind by Alias Name
 * ```typescript
 * const generate = yield* AWS.KMS.GenerateDataKeyWithoutPlaintext("alias/app-key");
 * ```
 *
 * @binding
 */
export interface GenerateDataKeyWithoutPlaintext extends Binding.Service<
  GenerateDataKeyWithoutPlaintext,
  "AWS.KMS.GenerateDataKeyWithoutPlaintext",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: GenerateDataKeyWithoutPlaintextRequest,
    ) => Effect.Effect<
      kms.GenerateDataKeyWithoutPlaintextResponse,
      kms.GenerateDataKeyWithoutPlaintextError
    >
  >
> {}

export const GenerateDataKeyWithoutPlaintext = Binding.Service<GenerateDataKeyWithoutPlaintext>(
  "AWS.KMS.GenerateDataKeyWithoutPlaintext",
);

export const GenerateDataKeyWithoutPlaintextHttp = Layer.effect(
  GenerateDataKeyWithoutPlaintext,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.GenerateDataKeyWithoutPlaintext",
    operation: kms.generateDataKeyWithoutPlaintext,
    actions: ["kms:GenerateDataKeyWithoutPlaintext"],
  }),
);
