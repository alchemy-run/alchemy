import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  PutSecretValue,
  type PutSecretValueRequest,
} from "./PutSecretValue.ts";
import type { Secret } from "./Secret.ts";

export const PutSecretValueHttp = Layer.effect(
  PutSecretValue,
  Effect.gen(function* () {
    const putSecretValue = yield* secretsmanager.putSecretValue;

    return Effect.fn(function* (secret: Secret) {
      const SecretId = yield* secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SecretsManager.PutSecretValue(${secret}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "secretsmanager:PutSecretValue",
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
        `AWS.SecretsManager.PutSecretValue(${secret.LogicalId})`,
      )(function* (request: PutSecretValueRequest) {
        const secretId = yield* SecretId;
        return yield* putSecretValue({
          ...request,
          SecretId: secretId,
        });
      });
    });
  }),
);
