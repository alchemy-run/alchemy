import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface GenerateMacRequest extends Omit<
  paymentcryptographydata.GenerateMacInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GenerateMac` — computes a
 * Message Authentication Code over hex-encoded message data under a
 * {@link Key}. Provide `GenerateMacHttp` on the Function to satisfy this
 * service.
 * ### Generating MACs
 * **Example:** Generate an HMAC over message data
 * ```typescript
 * // init
 * const generateMac = yield* PaymentCryptography.GenerateMac(macKey);
 *
 * // runtime — MessageData is hex-encoded
 * const result = yield* generateMac({
 *   MessageData: "31323334353637383930313233343536",
 *   GenerationAttributes: { Algorithm: "HMAC" },
 * });
 * ```
 *
 * @binding
 */
export interface GenerateMac extends Binding.Service<
  GenerateMac,
  "AWS.PaymentCryptography.GenerateMac",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: GenerateMacRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GenerateMacOutput,
      paymentcryptographydata.GenerateMacError
    >
  >
> {}

export const GenerateMac = Binding.Service<GenerateMac>("AWS.PaymentCryptography.GenerateMac");

/**
 * HTTP implementation of {@link GenerateMac} — grants the host Function
 * `payment-cryptography:GenerateMac` on the key and calls the
 * Payment Cryptography Data API at runtime.
 * @example Provide on a Lambda Function
 * ```typescript
 * Effect.gen(function* () {
 *   const macKey = yield* PaymentCryptography.Key("MacKey", {
 *     keyAttributes: {
 *       keyAlgorithm: "HMAC_SHA256",
 *       keyClass: "SYMMETRIC_KEY",
 *       keyUsage: "TR31_M7_HMAC_KEY",
 *       keyModesOfUse: { generate: true, verify: true },
 *     },
 *   });
 *   const generateMac = yield* PaymentCryptography.GenerateMac(macKey);
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const generated = yield* generateMac({
 *         MessageData: messageDataHex,
 *         GenerationAttributes: { Algorithm: "HMAC" },
 *       });
 *       // ...
 *     }),
 *   };
 * }).pipe(Effect.provide(PaymentCryptography.GenerateMacHttp))
 * ```
 */
export const GenerateMacHttp = Layer.effect(
  GenerateMac,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.GenerateMac",
    operation: paymentcryptographydata.generateMac,
    actions: ["payment-cryptography:GenerateMac"],
  }),
);
