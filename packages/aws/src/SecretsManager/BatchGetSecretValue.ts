import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Binding from "alchemy/Binding";
import type { Accessor } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Secret } from "./Secret.ts";

export interface BatchGetSecretValueRequest extends Omit<
  secretsmanager.BatchGetSecretValueRequest,
  "SecretIdList" | "Filters"
> {}

/**
 * Runtime binding for `secretsmanager:BatchGetSecretValue`.
 *
 * Bind this operation to a list of `Secret`s to get a callable that reads
 * all of their current values in a single call — the batch counterpart of
 * `GetSecretValue`. The bound secrets' ARNs are injected as the
 * `SecretIdList` and each secret is granted `secretsmanager:GetSecretValue`
 * (BatchGetSecretValue authorizes per-secret through GetSecretValue).
 * Provide the implementation with
 * `Effect.provide(AWS.SecretsManager.BatchGetSecretValueHttp)`.
 * ### Reading Secret Values
 * **Example:** Read Several Secrets at Once
 * ```typescript
 * // init — bind the operation to the secrets
 * const batchGet = yield* AWS.SecretsManager.BatchGetSecretValue([
 *   dbSecret,
 *   apiKeySecret,
 * ]);
 *
 * // runtime — one call, every current value
 * const result = yield* batchGet();
 * for (const entry of result.SecretValues ?? []) {
 *   console.log(entry.Name);
 * }
 * ```
 *
 * @binding
 */
export interface BatchGetSecretValue extends Binding.Service<
  BatchGetSecretValue,
  "AWS.SecretsManager.BatchGetSecretValue",
  (
    secrets: readonly Secret[],
  ) => Effect.Effect<
    (
      request?: BatchGetSecretValueRequest,
    ) => Effect.Effect<
      secretsmanager.BatchGetSecretValueResponse,
      secretsmanager.BatchGetSecretValueError
    >
  >
> {}

export const BatchGetSecretValue = Binding.Service<BatchGetSecretValue>(
  "AWS.SecretsManager.BatchGetSecretValue",
);

/**
 * Bespoke (multi-secret) HTTP binding: `BatchGetSecretValue` targets a list
 * of secrets, so it can't reuse the single-secret scaffolding — the account
 * -level `secretsmanager:BatchGetSecretValue` action is granted on `*` and
 * per-secret `GetSecretValue`/`DescribeSecret` on each bound secret's ARN.
 */
export const BatchGetSecretValueHttp = Layer.effect(
  BatchGetSecretValue,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const batchGetSecretValue = yield* AWSBindings.withCredentials(
      secretsmanager.batchGetSecretValue,
    );

    return Effect.fn(function* (secrets: readonly Secret[]) {
      const SecretIds: Accessor<string>[] = [];
      for (const secret of secrets) {
        SecretIds.push(yield* secret.secretArn);
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.SecretsManager.BatchGetSecretValue()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["secretsmanager:BatchGetSecretValue"],
              Resource: ["*"],
            },
          ],
        });
        for (const secret of secrets) {
          yield* bind`AWS.SecretsManager.BatchGetSecretValue(${secret})`({
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
