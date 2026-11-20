import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface DecryptDataRequest extends Omit<
  paymentcryptographydata.DecryptDataInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:DecryptData` — decrypts
 * ciphertext under a {@link Key}. Provide `DecryptDataHttp` on the Function
 * to satisfy this service.
 * ### Decrypting Data
 * **Example:** Decrypt ciphertext
 * ```typescript
 * // init
 * const decrypt = yield* PaymentCryptography.DecryptData(key);
 *
 * // runtime
 * const result = yield* decrypt({
 *   CipherText: cipherText,
 *   DecryptionAttributes: {
 *     Symmetric: { Mode: "CBC", InitializationVector: "00000000000000000000000000000000" },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface DecryptData extends Binding.Service<
  DecryptData,
  "AWS.PaymentCryptography.DecryptData",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: DecryptDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.DecryptDataOutput,
      paymentcryptographydata.DecryptDataError
    >
  >
> {}

export const DecryptData = Binding.Service<DecryptData>("AWS.PaymentCryptography.DecryptData");

/**
 * HTTP implementation of {@link DecryptData} — grants the host Function
 * `payment-cryptography:DecryptData` on the key and calls the
 * Payment Cryptography Data API at runtime.
 * @example Provide on a Lambda Function
 * ```typescript
 * Effect.gen(function* () {
 *   const key = yield* PaymentCryptography.Key("DataKey", { ... });
 *   const decrypt = yield* PaymentCryptography.DecryptData(key);
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const decrypted = yield* decrypt({
 *         CipherText: cipherTextHex,
 *         DecryptionAttributes: {
 *           Symmetric: { Mode: "CBC", InitializationVector: iv },
 *         },
 *       });
 *       // ...
 *     }),
 *   };
 * }).pipe(Effect.provide(PaymentCryptography.DecryptDataHttp))
 * ```
 */
export const DecryptDataHttp = Layer.effect(
  DecryptData,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.DecryptData",
    operation: paymentcryptographydata.decryptData,
    actions: ["payment-cryptography:DecryptData"],
  }),
);
