import * as authorization from "@distilled.cloud/stackit/authorization";
import * as Layer from "effect/Layer";
import { byResource, makeAuthorizationHttpBinding } from "./BindingHttp.ts";
import { ListUserPermissions } from "./ListUserPermissions.ts";

/**
 * HTTP implementation of {@link ListUserPermissions}.
 *
 * @layer
 * @provides Stackit.IAM.ListUserPermissions
 */
export const ListUserPermissionsHttp = Layer.effect(
  ListUserPermissions,
  makeAuthorizationHttpBinding({
    tag: "Stackit.IAM.ListUserPermissions",
    access: { permissions: ["iam.member.get"] },
    fields: byResource,
    operation: authorization.listUserPermissions,
  }),
);
