import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `secretsmanager:ListSecrets`.
 * @binding
 */
export interface ListSecrets extends Binding.Service<
  ListSecrets,
  "AWS.SecretsManager.ListSecrets",
  () => Effect.Effect<
    (
      request?: secretsmanager.ListSecretsRequest,
    ) => Effect.Effect<
      secretsmanager.ListSecretsResponse,
      secretsmanager.ListSecretsError
    >
  >
> {}

export const ListSecrets = Binding.Service<ListSecrets>(
  "AWS.SecretsManager.ListSecrets",
);
