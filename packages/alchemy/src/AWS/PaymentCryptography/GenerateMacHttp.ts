import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GenerateMac, type GenerateMacRequest } from "./GenerateMac.ts";
import type { Key } from "./Key.ts";

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
  Effect.gen(function* () {
    const generateMac = yield* paymentcryptographydata.generateMac;

    return Effect.fn(function* <K extends Key>(key: K) {
      const KeyArn = yield* key.keyArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.PaymentCryptography.GenerateMac(${key}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["payment-cryptography:GenerateMac"],
                  Resource: [key.keyArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.PaymentCryptography.GenerateMac(${key.LogicalId})`)(
        function* (request: GenerateMacRequest) {
          const keyArn = yield* KeyArn;
          return yield* generateMac({ ...request, KeyIdentifier: keyArn });
        },
      );
    });
  }),
);
