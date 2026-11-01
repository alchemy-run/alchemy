import * as logs from "@distilled.cloud/stackit/logs";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAccessPolicies } from "./ListAccessPolicies.ts";

/**
 * HTTP implementation of {@link ListAccessPolicies}.
 *
 * @layer
 * @provides Stackit.Logs.ListAccessPolicies
 */
export const ListAccessPoliciesHttp = Layer.effect(
  ListAccessPolicies,
  makeInstanceHttpBinding({
    tag: "Stackit.Logs.ListAccessPolicies",
    permission: "logs.instance.access-policies.list",
    operation: logs.listAccessPolicies,
  }),
);
