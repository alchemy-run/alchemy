import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface ReEncryptDataRequest extends Omit<
  paymentcryptographydata.ReEncryptDataInput,
  "IncomingKeyIdentifier" | "OutgoingKeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:ReEncryptData` — decrypts
 * ciphertext under the incoming {@link Key} and re-encrypts it under the
 * outgoing {@link Key} entirely inside the service; the plaintext never
 * leaves AWS Payment Cryptography. Provide `ReEncryptDataHttp` on the
 * Function to satisfy this service.
 * @binding
 * @section Re-Encrypting Data
 * @example Migrate ciphertext from one key to another
 * ```typescript
 * // init
 * const reEncrypt = yield* PaymentCryptography.ReEncryptData(oldKey, newKey);
 *
 * // runtime
 * const migrated = yield* reEncrypt({
 *   CipherText: cipherTextHex,
 *   IncomingEncryptionAttributes: {
 *     Symmetric: { Mode: "CBC", InitializationVector: iv },
 *   },
 *   OutgoingEncryptionAttributes: {
 *     Symmetric: { Mode: "CBC", InitializationVector: iv },
 *   },
 * });
 * ```
 */
export interface ReEncryptData extends Binding.Service<
  ReEncryptData,
  "AWS.PaymentCryptography.ReEncryptData",
  <In extends Key, Out extends Key>(
    incomingKey: In,
    outgoingKey: Out,
  ) => Effect.Effect<
    (
      request: ReEncryptDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.ReEncryptDataOutput,
      paymentcryptographydata.ReEncryptDataError
    >
  >
> {}

export const ReEncryptData = Binding.Service<ReEncryptData>(
  "AWS.PaymentCryptography.ReEncryptData",
);
