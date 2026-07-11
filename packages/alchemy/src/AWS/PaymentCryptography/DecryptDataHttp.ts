import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { DecryptData, type DecryptDataRequest } from "./DecryptData.ts";
import type { Key } from "./Key.ts";

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
  Effect.gen(function* () {
    const decryptData = yield* paymentcryptographydata.decryptData;

    return Effect.fn(function* <K extends Key>(key: K) {
      const KeyArn = yield* key.keyArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.PaymentCryptography.DecryptData(${key}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["payment-cryptography:DecryptData"],
                  Resource: [key.keyArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.PaymentCryptography.DecryptData(${key.LogicalId})`)(
        function* (request: DecryptDataRequest) {
          const keyArn = yield* KeyArn;
          return yield* decryptData({ ...request, KeyIdentifier: keyArn });
        },
      );
    });
  }),
);
