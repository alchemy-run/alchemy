import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAppRoleSecretIds } from "./ListAppRoleSecretIds.ts";

/**
 * HTTP implementation of {@link ListAppRoleSecretIds}.
 *
 * @layer
 * @provides Stackit.SecretsManager.ListAppRoleSecretIds
 */
export const ListAppRoleSecretIdsHttp = Layer.effect(
  ListAppRoleSecretIds,
  makeInstanceHttpBinding({
    tag: "Stackit.SecretsManager.ListAppRoleSecretIds",
    operation: secretsManager.listApproleSecretIds,
  }),
);
