import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyPairHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface TranslatePinDataRequest extends Omit<
  paymentcryptographydata.TranslatePinDataInput,
  "IncomingKeyIdentifier" | "OutgoingKeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:TranslatePinData` — translates
 * an encrypted PIN block from one PIN encryption {@link Key} (and ISO 9564
 * format) to another without the PIN ever leaving the service. This is the
 * core acquirer operation for forwarding PIN blocks between networks.
 * Provide `TranslatePinDataHttp` on the Function to satisfy this service.
 * ### PIN Data
 * **Example:** Translate a PIN block between two PEKs
 * ```typescript
 * // init
 * const translatePin = yield* PaymentCryptography.TranslatePinData(pek, partnerPek);
 *
 * // runtime
 * const translated = yield* translatePin({
 *   IncomingTranslationAttributes: {
 *     IsoFormat0: { PrimaryAccountNumber: pan },
 *   },
 *   OutgoingTranslationAttributes: {
 *     IsoFormat0: { PrimaryAccountNumber: pan },
 *   },
 *   EncryptedPinBlock: encryptedPinBlock,
 * });
 * ```
 *
 * @binding
 */
export interface TranslatePinData extends Binding.Service<
  TranslatePinData,
  "AWS.PaymentCryptography.TranslatePinData",
  <In extends Key, Out extends Key>(
    incomingKey: In,
    outgoingKey: Out,
  ) => Effect.Effect<
    (
      request: TranslatePinDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.TranslatePinDataOutput,
      paymentcryptographydata.TranslatePinDataError
    >
  >
> {}

export const TranslatePinData = Binding.Service<TranslatePinData>(
  "AWS.PaymentCryptography.TranslatePinData",
);

/**
 * HTTP implementation of {@link TranslatePinData} — grants the host Function
 * `payment-cryptography:TranslatePinData` on both the incoming and outgoing
 * PIN encryption keys and calls the Payment Cryptography Data API at
 * runtime.
 */
export const TranslatePinDataHttp = Layer.effect(
  TranslatePinData,
  makePaymentCryptographyKeyPairHttpBinding({
    tag: "AWS.PaymentCryptography.TranslatePinData",
    operation: paymentcryptographydata.translatePinData,
    actions: ["payment-cryptography:TranslatePinData"],
    keyFields: ["IncomingKeyIdentifier", "OutgoingKeyIdentifier"],
  }),
);
