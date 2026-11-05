import * as organizations from "@distilled.cloud/aws/organizations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `organizations:ListAccountsForParent`.
 *
 * Lists the accounts directly contained by the specified root or organizational unit (not accounts in child OUs).
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListAccountsForParentHttp)`.
 * ### Reading the Organization Tree
 * **Example:** List Accounts Under an OU
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAccountsForParent = yield* AWS.Organizations.ListAccountsForParent();
 *
 * // runtime
 * const { Accounts } = yield* listAccountsForParent({ ParentId: ouId });
 * ```
 *
 * @binding
 */
export interface ListAccountsForParent extends Binding.Service<
  ListAccountsForParent,
  "AWS.Organizations.ListAccountsForParent",
  () => Effect.Effect<
    (
      request: organizations.ListAccountsForParentRequest,
    ) => Effect.Effect<
      organizations.ListAccountsForParentResponse,
      organizations.ListAccountsForParentError
    >
  >
> {}
export const ListAccountsForParent = Binding.Service<ListAccountsForParent>(
  "AWS.Organizations.ListAccountsForParent",
);

export const ListAccountsForParentHttp = Layer.effect(
  ListAccountsForParent,
  makeOrganizationsHttpBinding({
    capability: "ListAccountsForParent",
    iamActions: ["organizations:ListAccountsForParent"],
    operation: organizations.listAccountsForParent,
  }),
);
