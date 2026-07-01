import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

export interface PutSecretValueRequest extends Omit<
  secretsmanager.PutSecretValueRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:PutSecretValue`.
 * @binding
 */
export interface PutSecretValue extends Binding.Service<
  PutSecretValue,
  "AWS.SecretsManager.PutSecretValue",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request: PutSecretValueRequest,
    ) => Effect.Effect<
      secretsmanager.PutSecretValueResponse,
      secretsmanager.PutSecretValueError
    >
  >
> {}

export const PutSecretValue = Binding.Service<PutSecretValue>(
  "AWS.SecretsManager.PutSecretValue",
);
