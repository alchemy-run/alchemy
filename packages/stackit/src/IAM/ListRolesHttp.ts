import * as authorization from "@distilled.cloud/stackit/authorization";
import * as Layer from "effect/Layer";
import { byResourceId, makeAuthorizationHttpBinding } from "./BindingHttp.ts";
import { ListRoles } from "./ListRoles.ts";

/**
 * HTTP implementation of {@link ListRoles}.
 *
 * @layer
 * @provides Stackit.IAM.ListRoles
 */
export const ListRolesHttp = Layer.effect(
  ListRoles,
  makeAuthorizationHttpBinding({
    tag: "Stackit.IAM.ListRoles",
    access: { permissions: ["iam.role.get", "iam.role.list"] },
    fields: byResourceId,
    operation: authorization.listRoles,
  }),
);
