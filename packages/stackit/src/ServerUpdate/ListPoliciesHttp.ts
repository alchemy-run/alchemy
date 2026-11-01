import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListPolicies } from "./ListPolicies.ts";

/**
 * HTTP implementation of {@link ListPolicies}.
 *
 * @layer
 * @provides Stackit.ServerUpdate.ListPolicies
 */
export const ListPoliciesHttp = Layer.effect(
  ListPolicies,
  makeProjectHttpBinding({
    tag: "Stackit.ServerUpdate.ListPolicies",
    access: { permissions: ["server-update.policy.list"] },
    operation: serverUpdate.listUpdatePolicies,
  }),
);
