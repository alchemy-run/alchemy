import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAppRole } from "./GetAppRole.ts";

/**
 * HTTP implementation of {@link GetAppRole}.
 *
 * @layer
 * @provides Stackit.SecretsManager.GetAppRole
 */
export const GetAppRoleHttp = Layer.effect(
  GetAppRole,
  makeInstanceHttpBinding({
    tag: "Stackit.SecretsManager.GetAppRole",
    operation: secretsManager.getApprole,
  }),
);
