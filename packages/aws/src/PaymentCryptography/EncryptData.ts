import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface EncryptDataRequest extends Omit<
  paymentcryptographydata.EncryptDataInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:EncryptData` — encrypts
 * hex-encoded plaintext under a {@link Key}. Provide `EncryptDataHttp` on
 * the Function to satisfy this service.
 * ### Encrypting Data
 * **Example:** Encrypt hex-encoded plaintext
 * ```typescript
 * // init
 * const encrypt = yield* PaymentCryptography.EncryptData(key);
 *
 * // runtime
 * const result = yield* encrypt({
 *   PlainText: "31323334353637383930313233343536",
 *   EncryptionAttributes: {
 *     Symmetric: { Mode: "CBC", InitializationVector: "00000000000000000000000000000000" },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface EncryptData extends Binding.Service<
  EncryptData,
  "AWS.PaymentCryptography.EncryptData",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: EncryptDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.EncryptDataOutput,
      paymentcryptographydata.EncryptDataError
    >
  >
> {}

export const EncryptData = Binding.Service<EncryptData>("AWS.PaymentCryptography.EncryptData");

/**
 * HTTP implementation of {@link EncryptData} — grants the host Function
 * `payment-cryptography:EncryptData` on the key and calls the
 * Payment Cryptography Data API at runtime.
 * @example Provide on a Lambda Function
 * ```typescript
 * Effect.gen(function* () {
 *   const key = yield* PaymentCryptography.Key("DataKey", { ... });
 *   const encrypt = yield* PaymentCryptography.EncryptData(key);
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const encrypted = yield* encrypt({
 *         PlainText: plainTextHex,
 *         EncryptionAttributes: {
 *           Symmetric: { Mode: "CBC", InitializationVector: iv },
 *         },
 *       });
 *       // ...
 *     }),
 *   };
 * }).pipe(Effect.provide(PaymentCryptography.EncryptDataHttp))
 * ```
 */
export const EncryptDataHttp = Layer.effect(
  EncryptData,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.EncryptData",
    operation: paymentcryptographydata.encryptData,
    actions: ["payment-cryptography:EncryptData"],
  }),
);
