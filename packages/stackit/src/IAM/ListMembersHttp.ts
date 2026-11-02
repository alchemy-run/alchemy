import * as authorization from "@distilled.cloud/stackit/authorization";
import * as Layer from "effect/Layer";
import { byResourceId, makeAuthorizationHttpBinding } from "./BindingHttp.ts";
import { ListMembers } from "./ListMembers.ts";

/**
 * HTTP implementation of {@link ListMembers}.
 *
 * @layer
 * @provides Stackit.IAM.ListMembers
 */
export const ListMembersHttp = Layer.effect(
  ListMembers,
  makeAuthorizationHttpBinding({
    tag: "Stackit.IAM.ListMembers",
    access: { permissions: ["iam.member.get"] },
    fields: byResourceId,
    operation: authorization.listMembers,
  }),
);
