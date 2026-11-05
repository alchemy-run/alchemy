import * as fms from "@distilled.cloud/aws/fms";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link ListPolicies}.
 */
export interface ListPoliciesRequest extends fms.ListPoliciesRequest {}

/**
 * Runtime binding for `fms:ListPolicies`.
 *
 * Returns the `PolicySummary` list for the Firewall Manager policies in the administrator's account. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListPoliciesHttp)`.
 * ### Reading Policies
 * **Example:** List Policies
 * ```typescript
 * // init — account-level binding takes no resource
 * const listPolicies = yield* AWS.FMS.ListPolicies();
 *
 * // runtime
 * const result = yield* listPolicies();
 * console.log(result.PolicyList?.length);
 * ```
 *
 * @binding
 */
export interface ListPolicies extends Binding.Service<
  ListPolicies,
  "AWS.FMS.ListPolicies",
  () => Effect.Effect<
    (
      request?: ListPoliciesRequest,
    ) => Effect.Effect<fms.ListPoliciesResponse, fms.ListPoliciesError>
  >
> {}

export const ListPolicies = Binding.Service<ListPolicies>("AWS.FMS.ListPolicies");

export const ListPoliciesHttp = Layer.effect(
  ListPolicies,
  makeFmsHttpBinding({
    capability: "ListPolicies",
    iamActions: ["fms:ListPolicies"],
    operation: fms.listPolicies,
  }),
);
