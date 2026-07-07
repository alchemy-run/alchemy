import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { DescribeSecret } from "./DescribeSecret.ts";
import type { Secret } from "./Secret.ts";

export const DescribeSecretHttp = Layer.effect(
  DescribeSecret,
  Effect.gen(function* () {
    const describeSecret = yield* secretsmanager.describeSecret;

    return Effect.fn(function* (secret: Secret) {
      const SecretId = yield* secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SecretsManager.DescribeSecret(${secret}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["secretsmanager:DescribeSecret"],
                  Resource: [secret.secretArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.SecretsManager.DescribeSecret(${secret.LogicalId})`,
      )(function* () {
        return yield* describeSecret({
          SecretId: yield* SecretId,
        });
      });
    });
  }),
);
