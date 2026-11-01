import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAppRoles } from "./ListAppRoles.ts";

/**
 * HTTP implementation of {@link ListAppRoles}.
 *
 * @layer
 * @provides Stackit.SecretsManager.ListAppRoles
 */
export const ListAppRolesHttp = Layer.effect(
  ListAppRoles,
  makeInstanceHttpBinding({
    tag: "Stackit.SecretsManager.ListAppRoles",
    operation: secretsManager.listApproles,
  }),
);
