import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Accessor } from "../../Output.ts";
import * as HostAccess from "../HostAccess.ts";
import { BatchGetSecretValue, type BatchGetSecretValueRequest } from "./BatchGetSecretValue.ts";
import type { Secret } from "./Secret.ts";

/**
 * Bespoke (multi-secret) HTTP binding: `BatchGetSecretValue` targets a list
 * of secrets, so it can't reuse the single-secret scaffolding — the account
 * -level `secretsmanager:BatchGetSecretValue` action is granted on `*` and
 * per-secret `GetSecretValue`/`DescribeSecret` on each bound secret's ARN.
 */
export const BatchGetSecretValueHttp = Layer.effect(
  BatchGetSecretValue,
  Effect.gen(function* () {
    const batchGetSecretValue = yield* HostAccess.withCredentials(
      secretsmanager.batchGetSecretValue,
    );

    return Effect.fn(function* (secrets: readonly Secret[]) {
      const SecretIds: Accessor<string>[] = [];
      for (const secret of secrets) {
        SecretIds.push(yield* secret.secretArn);
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* HostAccess.bind`AWS.SecretsManager.BatchGetSecretValue()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["secretsmanager:BatchGetSecretValue"],
              Resource: ["*"],
            },
          ],
        });
        for (const secret of secrets) {
          yield* HostAccess.bind`AWS.SecretsManager.BatchGetSecretValue(${secret})`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
                Resource: [secret.secretArn],
              },
            ],
          });
        }
      }
      return Effect.fn(
        `AWS.SecretsManager.BatchGetSecretValue(${secrets
          .map((secret) => secret.LogicalId)
          .join(",")})`,
      )(function* (request?: BatchGetSecretValueRequest) {
        const secretIdList = [];
        for (const secretId of SecretIds) {
          secretIdList.push(yield* secretId);
        }
        return yield* batchGetSecretValue({
          ...request,
          SecretIdList: secretIdList,
        });
      });
    });
  }),
);
