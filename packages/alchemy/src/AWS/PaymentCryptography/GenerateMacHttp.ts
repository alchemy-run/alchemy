import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GenerateMac, type GenerateMacRequest } from "./GenerateMac.ts";
import type { Key } from "./Key.ts";

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
