import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  GetSecretValue,
  type GetSecretValueRequest,
} from "./GetSecretValue.ts";
import type { Secret } from "./Secret.ts";

export const GetSecretValueHttp = Layer.effect(
  GetSecretValue,
  Effect.gen(function* () {
    const getSecretValue = yield* secretsmanager.getSecretValue;

    return Effect.fn(function* (secret: Secret) {
      const SecretId = yield* secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SecretsManager.GetSecretValue(${secret}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "secretsmanager:GetSecretValue",
                    "secretsmanager:DescribeSecret",
                  ],
                  Resource: [secret.secretArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.SecretsManager.GetSecretValue(${secret.LogicalId})`,
      )(function* (request: GetSecretValueRequest = {}) {
        const secretId = yield* SecretId;
        return yield* getSecretValue({
          ...request,
          SecretId: secretId,
        });
      });
    });
  }),
);
