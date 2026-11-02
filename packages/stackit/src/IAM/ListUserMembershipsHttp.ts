import * as authorization from "@distilled.cloud/stackit/authorization";
import * as Layer from "effect/Layer";
import { byResourceId, makeAuthorizationHttpBinding } from "./BindingHttp.ts";
import { ListUserMemberships } from "./ListUserMemberships.ts";

/**
 * HTTP implementation of {@link ListUserMemberships}.
 *
 * @layer
 * @provides Stackit.IAM.ListUserMemberships
 */
export const ListUserMembershipsHttp = Layer.effect(
  ListUserMemberships,
  makeAuthorizationHttpBinding({
    tag: "Stackit.IAM.ListUserMemberships",
    access: { permissions: ["iam.member.get"] },
    fields: byResourceId,
    operation: authorization.listUserMemberships,
  }),
);
