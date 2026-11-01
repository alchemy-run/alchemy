import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAppRoleSecretId } from "./GetAppRoleSecretId.ts";

/**
 * HTTP implementation of {@link GetAppRoleSecretId}.
 *
 * @layer
 * @provides Stackit.SecretsManager.GetAppRoleSecretId
 */
export const GetAppRoleSecretIdHttp = Layer.effect(
  GetAppRoleSecretId,
  makeInstanceHttpBinding({
    tag: "Stackit.SecretsManager.GetAppRoleSecretId",
    operation: secretsManager.getApproleSecretId,
  }),
);
