import * as organizations from "@distilled.cloud/aws/organizations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `organizations:ListPoliciesForTarget`.
 *
 * Lists the policies of the specified type that are directly attached to the specified target root, OU, or account.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListPoliciesForTargetHttp)`.
 * ### Policies & Effective Policy
 * **Example:** List Policies Attached to a Target
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPoliciesForTarget = yield* AWS.Organizations.ListPoliciesForTarget();
 *
 * // runtime
 * const { Policies } = yield* listPoliciesForTarget({
 *   TargetId: accountId,
 *   Filter: "SERVICE_CONTROL_POLICY",
 * });
 * ```
 *
 * @binding
 */
export interface ListPoliciesForTarget extends Binding.Service<
  ListPoliciesForTarget,
  "AWS.Organizations.ListPoliciesForTarget",
  () => Effect.Effect<
    (
      request: organizations.ListPoliciesForTargetRequest,
    ) => Effect.Effect<
      organizations.ListPoliciesForTargetResponse,
      organizations.ListPoliciesForTargetError
    >
  >
> {}
export const ListPoliciesForTarget = Binding.Service<ListPoliciesForTarget>(
  "AWS.Organizations.ListPoliciesForTarget",
);

export const ListPoliciesForTargetHttp = Layer.effect(
  ListPoliciesForTarget,
  makeOrganizationsHttpBinding({
    capability: "ListPoliciesForTarget",
    iamActions: ["organizations:ListPoliciesForTarget"],
    operation: organizations.listPoliciesForTarget,
  }),
);
