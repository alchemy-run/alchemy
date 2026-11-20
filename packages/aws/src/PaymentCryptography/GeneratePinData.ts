import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyPairHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface GeneratePinDataRequest extends Omit<
  paymentcryptographydata.GeneratePinDataInput,
  "GenerationKeyIdentifier" | "EncryptionKeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GeneratePinData` — generates
 * PIN-related data (PIN, PVV, PIN block) under a PIN generation {@link Key}
 * (e.g. a Visa PVK) and returns the PIN block encrypted under a PIN
 * encryption {@link Key} (PEK). Provide `GeneratePinDataHttp` on the
 * Function to satisfy this service.
 * ### PIN Data
 * **Example:** Generate a Visa PIN + PVV
 * ```typescript
 * // init
 * const generatePin = yield* PaymentCryptography.GeneratePinData(pvk, pek);
 *
 * // runtime
 * const generated = yield* generatePin({
 *   GenerationAttributes: { VisaPin: { PinVerificationKeyIndex: 1 } },
 *   PrimaryAccountNumber: "9123456789012345",
 *   PinBlockFormat: "ISO_FORMAT_0",
 * });
 * // generated.EncryptedPinBlock + generated.PinData.VerificationValue
 * ```
 *
 * @binding
 */
export interface GeneratePinData extends Binding.Service<
  GeneratePinData,
  "AWS.PaymentCryptography.GeneratePinData",
  <G extends Key, E extends Key>(
    generationKey: G,
    encryptionKey: E,
  ) => Effect.Effect<
    (
      request: GeneratePinDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GeneratePinDataOutput,
      paymentcryptographydata.GeneratePinDataError
    >
  >
> {}

export const GeneratePinData = Binding.Service<GeneratePinData>(
  "AWS.PaymentCryptography.GeneratePinData",
);

/**
 * HTTP implementation of {@link GeneratePinData} — grants the host Function
 * `payment-cryptography:GeneratePinData` on both the generation key (PVK)
 * and the encryption key (PEK) and calls the Payment Cryptography Data API
 * at runtime.
 */
export const GeneratePinDataHttp = Layer.effect(
  GeneratePinData,
  makePaymentCryptographyKeyPairHttpBinding({
    tag: "AWS.PaymentCryptography.GeneratePinData",
    operation: paymentcryptographydata.generatePinData,
    actions: ["payment-cryptography:GeneratePinData"],
    keyFields: ["GenerationKeyIdentifier", "EncryptionKeyIdentifier"],
  }),
);
