import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { EncryptData, type EncryptDataRequest } from "./EncryptData.ts";
import type { Key } from "./Key.ts";

export const EncryptDataHttp = Layer.effect(
  EncryptData,
  Effect.gen(function* () {
    const encryptData = yield* paymentcryptographydata.encryptData;

    return Effect.fn(function* <K extends Key>(key: K) {
      const KeyArn = yield* key.keyArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.PaymentCryptography.EncryptData(${key}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["payment-cryptography:EncryptData"],
                  Resource: [key.keyArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.PaymentCryptography.EncryptData(${key.LogicalId})`)(
        function* (request: EncryptDataRequest) {
          const keyArn = yield* KeyArn;
          return yield* encryptData({ ...request, KeyIdentifier: keyArn });
        },
      );
    });
  }),
);
