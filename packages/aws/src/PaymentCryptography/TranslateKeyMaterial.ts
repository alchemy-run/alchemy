import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Key } from "./Key.ts";

export interface TranslateKeyMaterialRequest
  extends paymentcryptographydata.TranslateKeyMaterialInput {}

/**
 * Runtime binding for `payment-cryptography:TranslateKeyMaterial` —
 * translates an ECDH-derived TR-31 wrapped key block into a TR-31 key block
 * wrapped under a Key Encryption Key, without importing the short-lived key
 * into the service. The key identifiers live in nested request structures
 * (`IncomingKeyMaterial.DiffieHellmanTr31KeyBlock.PrivateKeyIdentifier`,
 * `OutgoingKeyMaterial.Tr31KeyBlock.WrappingKeyIdentifier`), so the caller
 * supplies the full request; bind every {@link Key} the request references
 * so the Function is granted the action on each. Provide
 * `TranslateKeyMaterialHttp` on the Function to satisfy this service.
 * ### Key Material Translation
 * **Example:** Translate an ECDH-wrapped key to a KEK-wrapped TR-31 block
 * ```typescript
 * // init — grant on every key the request references
 * const translateKeyMaterial =
 *   yield* PaymentCryptography.TranslateKeyMaterial(ecdhPrivateKey, caKey, kek);
 * const ecdhPrivateKeyArn = yield* ecdhPrivateKey.keyArn;
 * const caKeyArn = yield* caKey.keyArn;
 * const kekArn = yield* kek.keyArn;
 *
 * // runtime
 * const translated = yield* translateKeyMaterial({
 *   IncomingKeyMaterial: {
 *     DiffieHellmanTr31KeyBlock: {
 *       PrivateKeyIdentifier: yield* ecdhPrivateKeyArn,
 *       CertificateAuthorityPublicKeyIdentifier: yield* caKeyArn,
 *       // ...
 *     },
 *   },
 *   OutgoingKeyMaterial: { Tr31KeyBlock: { WrappingKeyIdentifier: yield* kekArn } },
 * });
 * ```
 *
 * @binding
 */
export interface TranslateKeyMaterial extends Binding.Service<
  TranslateKeyMaterial,
  "AWS.PaymentCryptography.TranslateKeyMaterial",
  (
    ...keys: readonly [Key, ...Key[]]
  ) => Effect.Effect<
    (
      request: TranslateKeyMaterialRequest,
    ) => Effect.Effect<
      paymentcryptographydata.TranslateKeyMaterialOutput,
      paymentcryptographydata.TranslateKeyMaterialError
    >
  >
> {}

export const TranslateKeyMaterial = Binding.Service<TranslateKeyMaterial>(
  "AWS.PaymentCryptography.TranslateKeyMaterial",
);

/**
 * HTTP implementation of {@link TranslateKeyMaterial} — bespoke (not
 * scaffolded): the key identifiers live in nested request structures
 * (`IncomingKeyMaterial.DiffieHellmanTr31KeyBlock.PrivateKeyIdentifier`,
 * `OutgoingKeyMaterial.Tr31KeyBlock.WrappingKeyIdentifier`) whose union arms
 * vary by exchange scheme, so nothing is injected. The deploy-time half
 * grants `payment-cryptography:TranslateKeyMaterial` on every bound
 * {@link Key}; the caller supplies the full request (resolving each key's
 * ARN itself).
 */
export const TranslateKeyMaterialHttp = Layer.effect(
  TranslateKeyMaterial,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const translateKeyMaterial = yield* AWSBindings.withCredentials(
      paymentcryptographydata.translateKeyMaterial,
    );

    return Effect.fn(function* (...keys: readonly [Key, ...Key[]]) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        for (const key of keys) {
          yield* bind`AWS.PaymentCryptography.TranslateKeyMaterial(${key})`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["payment-cryptography:TranslateKeyMaterial"],
                Resource: [key.keyArn],
              },
            ],
          });
        }
      }
      return Effect.fn(
        `AWS.PaymentCryptography.TranslateKeyMaterial(${keys
          .map((key) => key.LogicalId)
          .join(", ")})`,
      )(function* (request: TranslateKeyMaterialRequest) {
        return yield* translateKeyMaterial(request);
      });
    });
  }),
);
