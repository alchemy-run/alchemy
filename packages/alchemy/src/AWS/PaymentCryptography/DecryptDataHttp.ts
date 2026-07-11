import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { DecryptData, type DecryptDataRequest } from "./DecryptData.ts";
import type { Key } from "./Key.ts";

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
