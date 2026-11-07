import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface VerifyMacRequest extends Omit<
  paymentcryptographydata.VerifyMacInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:VerifyMac` — verifies a Message
 * Authentication Code against hex-encoded message data under a {@link Key}.
 * A mismatched MAC fails with the typed `VerificationFailedException`.
 * Provide `VerifyMacHttp` on the Function to satisfy this service.
 * ### Verifying MACs
 * **Example:** Verify an HMAC
 * ```typescript
 * // init
 * const verifyMac = yield* PaymentCryptography.VerifyMac(macKey);
 *
 * // runtime — MessageData and Mac are hex-encoded
 * yield* verifyMac({
 *   MessageData: "31323334353637383930313233343536",
 *   Mac: mac,
 *   VerificationAttributes: { Algorithm: "HMAC" },
 * });
 * ```
 *
 * @binding
 */
export interface VerifyMac extends Binding.Service<
  VerifyMac,
  "AWS.PaymentCryptography.VerifyMac",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: VerifyMacRequest,
    ) => Effect.Effect<
      paymentcryptographydata.VerifyMacOutput,
      paymentcryptographydata.VerifyMacError
    >
  >
> {}

export const VerifyMac = Binding.Service<VerifyMac>("AWS.PaymentCryptography.VerifyMac");

/**
 * HTTP implementation of {@link VerifyMac} — grants the host Function
 * `payment-cryptography:VerifyMac` on the key and calls the
 * Payment Cryptography Data API at runtime. A MAC mismatch fails with the
 * typed `VerificationFailedException`.
 * @example Provide on a Lambda Function
 * ```typescript
 * Effect.gen(function* () {
 *   const macKey = yield* PaymentCryptography.Key("MacKey", { ... });
 *   const verifyMac = yield* PaymentCryptography.VerifyMac(macKey);
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const result = yield* verifyMac({
 *         MessageData: messageDataHex,
 *         Mac: mac,
 *         VerificationAttributes: { Algorithm: "HMAC" },
 *       }).pipe(
 *         Effect.map(() => "verified"),
 *         Effect.catchTag("VerificationFailedException", () =>
 *           Effect.succeed("verification-failed"),
 *         ),
 *       );
 *       // ...
 *     }),
 *   };
 * }).pipe(Effect.provide(PaymentCryptography.VerifyMacHttp))
 * ```
 */
export const VerifyMacHttp = Layer.effect(
  VerifyMac,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.VerifyMac",
    operation: paymentcryptographydata.verifyMac,
    actions: ["payment-cryptography:VerifyMac"],
  }),
);
