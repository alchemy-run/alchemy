import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

export interface GetSecretValueRequest extends Omit<
  secretsmanager.GetSecretValueRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:GetSecretValue`.
 * @binding
 */
export interface GetSecretValue extends Binding.Service<
  GetSecretValue,
  "AWS.SecretsManager.GetSecretValue",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: GetSecretValueRequest,
    ) => Effect.Effect<
      secretsmanager.GetSecretValueResponse,
      secretsmanager.GetSecretValueError
    >
  >
> {}

export const GetSecretValue = Binding.Service<GetSecretValue>(
  "AWS.SecretsManager.GetSecretValue",
);
