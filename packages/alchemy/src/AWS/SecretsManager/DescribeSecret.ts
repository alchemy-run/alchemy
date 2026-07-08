import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

/**
 * Runtime binding for `secretsmanager:DescribeSecret`.
 * @binding
 */
export interface DescribeSecret extends Binding.Service<
  DescribeSecret,
  "AWS.SecretsManager.DescribeSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    () => Effect.Effect<
      secretsmanager.DescribeSecretResponse,
      secretsmanager.DescribeSecretError
    >
  >
> {}

export const DescribeSecret = Binding.Service<DescribeSecret>(
  "AWS.SecretsManager.DescribeSecret",
);
