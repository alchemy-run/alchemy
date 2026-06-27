import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `secretsmanager:GetRandomPassword`.
 * @binding
 */
export interface GetRandomPassword extends Binding.Service<
  GetRandomPassword,
  "AWS.SecretsManager.GetRandomPassword",
  () => Effect.Effect<
    (
      request?: secretsmanager.GetRandomPasswordRequest,
    ) => Effect.Effect<
      secretsmanager.GetRandomPasswordResponse,
      secretsmanager.GetRandomPasswordError
    >
  >
> {}

export const GetRandomPassword = Binding.Service<GetRandomPassword>(
  "AWS.SecretsManager.GetRandomPassword",
);
