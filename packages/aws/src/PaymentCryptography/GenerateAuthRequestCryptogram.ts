import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import type { Key } from "./Key.ts";

export interface GenerateAuthRequestCryptogramRequest extends Omit<
  paymentcryptographydata.GenerateAuthRequestCryptogramInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GenerateAuthRequestCryptogram` —
 * generates an Authorization Request Cryptogram (ARQC) for AS2805 terminal
 * transactions under an EMV issuer master {@link Key}. Provide
 * `GenerateAuthRequestCryptogramHttp` on the Function to satisfy this
 * service.
 * ### EMV Cryptograms
 * **Example:** Generate an ARQC for transaction data
 * ```typescript
 * // init
 * const generateArqc =
 *   yield* PaymentCryptography.GenerateAuthRequestCryptogram(issuerMasterKey);
 *
 * // runtime
 * const generated = yield* generateArqc({
 *   TransactionData: transactionDataHex,
 *   MajorKeyDerivationMode: "EMV_OPTION_A",
 *   SessionKeyDerivationAttributes: {
 *     EmvCommon: { PrimaryAccountNumber: pan, PanSequenceNumber: "00", ApplicationTransactionCounter: "0001" },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface GenerateAuthRequestCryptogram extends Binding.Service<
  GenerateAuthRequestCryptogram,
  "AWS.PaymentCryptography.GenerateAuthRequestCryptogram",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: GenerateAuthRequestCryptogramRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GenerateAuthRequestCryptogramOutput,
      paymentcryptographydata.GenerateAuthRequestCryptogramError
    >
  >
> {}

export const GenerateAuthRequestCryptogram = Binding.Service<GenerateAuthRequestCryptogram>(
  "AWS.PaymentCryptography.GenerateAuthRequestCryptogram",
);

/**
 * HTTP implementation of {@link GenerateAuthRequestCryptogram} — grants the
 * host Function `payment-cryptography:GenerateAuthRequestCryptogram` on the
 * issuer master key and calls the Payment Cryptography Data API at runtime.
 */
export const GenerateAuthRequestCryptogramHttp = Layer.effect(
  GenerateAuthRequestCryptogram,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.GenerateAuthRequestCryptogram",
    operation: paymentcryptographydata.generateAuthRequestCryptogram,
    actions: ["payment-cryptography:GenerateAuthRequestCryptogram"],
  }),
);
