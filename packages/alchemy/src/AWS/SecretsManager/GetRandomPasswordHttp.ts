import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { GetRandomPassword } from "./GetRandomPassword.ts";

export const GetRandomPasswordHttp = Layer.effect(
  GetRandomPassword,
  Effect.gen(function* () {
    const getRandomPassword = yield* secretsmanager.getRandomPassword;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SecretsManager.GetRandomPassword())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["secretsmanager:GetRandomPassword"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn("AWS.SecretsManager.GetRandomPassword")(function* (
        request: secretsmanager.GetRandomPasswordRequest = {},
      ) {
        return yield* getRandomPassword(request);
      });
    });
  }),
);
