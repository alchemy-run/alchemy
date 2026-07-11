import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Key } from "./Key.ts";
import { VerifyMac, type VerifyMacRequest } from "./VerifyMac.ts";

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
  Effect.gen(function* () {
    const verifyMac = yield* paymentcryptographydata.verifyMac;

    return Effect.fn(function* <K extends Key>(key: K) {
      const KeyArn = yield* key.keyArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.PaymentCryptography.VerifyMac(${key}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["payment-cryptography:VerifyMac"],
                  Resource: [key.keyArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.PaymentCryptography.VerifyMac(${key.LogicalId})`)(
        function* (request: VerifyMacRequest) {
          const keyArn = yield* KeyArn;
          return yield* verifyMac({ ...request, KeyIdentifier: keyArn });
        },
      );
    });
  }),
);
