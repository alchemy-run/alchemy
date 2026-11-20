import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Key } from "./Key.ts";

export interface GenerateMacEmvPinChangeRequest extends Omit<
  paymentcryptographydata.GenerateMacEmvPinChangeInput,
  | "NewPinPekIdentifier"
  | "SecureMessagingIntegrityKeyIdentifier"
  | "SecureMessagingConfidentialityKeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GenerateMacEmvPinChange` —
 * generates the issuer-script MAC (and re-encrypted PIN block) for an EMV
 * PIN change command. Binds three {@link Key}s: the new PIN encryption key
 * (PEK) the changed PIN is encrypted under, and the secure-messaging
 * integrity and confidentiality issuer master keys. Provide
 * `GenerateMacEmvPinChangeHttp` on the Function to satisfy this service.
 * ### EMV PIN Change
 * **Example:** Generate the issuer-script MAC for a PIN change
 * ```typescript
 * // init
 * const generatePinChangeMac = yield* PaymentCryptography.GenerateMacEmvPinChange(
 *   newPinPek,
 *   secureMessagingIntegrityKey,
 *   secureMessagingConfidentialityKey,
 * );
 *
 * // runtime
 * const result = yield* generatePinChangeMac({
 *   NewEncryptedPinBlock: newEncryptedPinBlock,
 *   PinBlockFormat: "ISO_FORMAT_0",
 *   MessageData: messageDataHex,
 *   DerivationMethodAttributes: { Emv2000: { ... } },
 * });
 * ```
 *
 * @binding
 */
export interface GenerateMacEmvPinChange extends Binding.Service<
  GenerateMacEmvPinChange,
  "AWS.PaymentCryptography.GenerateMacEmvPinChange",
  <P extends Key, I extends Key, C extends Key>(
    newPinPek: P,
    secureMessagingIntegrityKey: I,
    secureMessagingConfidentialityKey: C,
  ) => Effect.Effect<
    (
      request: GenerateMacEmvPinChangeRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GenerateMacEmvPinChangeOutput,
      paymentcryptographydata.GenerateMacEmvPinChangeError
    >
  >
> {}

export const GenerateMacEmvPinChange = Binding.Service<GenerateMacEmvPinChange>(
  "AWS.PaymentCryptography.GenerateMacEmvPinChange",
);

/**
 * HTTP implementation of {@link GenerateMacEmvPinChange} — bespoke (not
 * scaffolded): the operation spans three keys (the new PIN PEK plus the
 * secure-messaging integrity and confidentiality keys). Grants the host
 * Function `payment-cryptography:GenerateMacEmvPinChange` on all three key
 * ARNs and injects each identifier at runtime.
 */
export const GenerateMacEmvPinChangeHttp = Layer.effect(
  GenerateMacEmvPinChange,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const generateMacEmvPinChange = yield* AWSBindings.withCredentials(
      paymentcryptographydata.generateMacEmvPinChange,
    );

    return Effect.fn(function* <P extends Key, I extends Key, C extends Key>(
      newPinPek: P,
      secureMessagingIntegrityKey: I,
      secureMessagingConfidentialityKey: C,
    ) {
      const NewPinPekArn = yield* newPinPek.keyArn;
      const IntegrityKeyArn = yield* secureMessagingIntegrityKey.keyArn;
      const ConfidentialityKeyArn = yield* secureMessagingConfidentialityKey.keyArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        for (const key of [
          newPinPek,
          secureMessagingIntegrityKey,
          secureMessagingConfidentialityKey,
        ]) {
          yield* bind`AWS.PaymentCryptography.GenerateMacEmvPinChange(${key})`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["payment-cryptography:GenerateMacEmvPinChange"],
                Resource: [key.keyArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.PaymentCryptography.GenerateMacEmvPinChange(${newPinPek.LogicalId})`)(
        function* (request: GenerateMacEmvPinChangeRequest) {
          return yield* generateMacEmvPinChange({
            ...request,
            NewPinPekIdentifier: yield* NewPinPekArn,
            SecureMessagingIntegrityKeyIdentifier: yield* IntegrityKeyArn,
            SecureMessagingConfidentialityKeyIdentifier: yield* ConfidentialityKeyArn,
          });
        },
      );
    });
  }),
);
