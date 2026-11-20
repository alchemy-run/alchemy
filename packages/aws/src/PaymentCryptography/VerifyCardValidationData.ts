import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface VerifyCardValidationDataRequest extends Omit<
  paymentcryptographydata.VerifyCardValidationDataInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:VerifyCardValidationData` —
 * verifies card validation values (CVV/CVV2, dCVV, CSC) under the same Card
 * Verification Key (CVK) {@link Key} used to generate them. A mismatch fails
 * with the typed `VerificationFailedException`. Provide
 * `VerifyCardValidationDataHttp` on the Function to satisfy this service.
 * ### Card Validation Data
 * **Example:** Verify a CVV2 presented in a transaction
 * ```typescript
 * // init
 * const verifyCvv2 = yield* PaymentCryptography.VerifyCardValidationData(cvk);
 *
 * // runtime
 * const outcome = yield* verifyCvv2({
 *   PrimaryAccountNumber: "9123456789012345",
 *   VerificationAttributes: {
 *     CardVerificationValue2: { CardExpiryDate: "0130" },
 *   },
 *   ValidationData: cvv2,
 * }).pipe(
 *   Effect.map(() => "valid"),
 *   Effect.catchTag("VerificationFailedException", () =>
 *     Effect.succeed("invalid"),
 *   ),
 * );
 * ```
 *
 * @binding
 */
export interface VerifyCardValidationData extends Binding.Service<
  VerifyCardValidationData,
  "AWS.PaymentCryptography.VerifyCardValidationData",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: VerifyCardValidationDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.VerifyCardValidationDataOutput,
      paymentcryptographydata.VerifyCardValidationDataError
    >
  >
> {}

export const VerifyCardValidationData = Binding.Service<VerifyCardValidationData>(
  "AWS.PaymentCryptography.VerifyCardValidationData",
);

/**
 * HTTP implementation of {@link VerifyCardValidationData} — grants the host
 * Function `payment-cryptography:VerifyCardValidationData` on the CVK and
 * calls the Payment Cryptography Data API at runtime. A mismatch fails with
 * the typed `VerificationFailedException`.
 */
export const VerifyCardValidationDataHttp = Layer.effect(
  VerifyCardValidationData,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.VerifyCardValidationData",
    operation: paymentcryptographydata.verifyCardValidationData,
    actions: ["payment-cryptography:VerifyCardValidationData"],
  }),
);
