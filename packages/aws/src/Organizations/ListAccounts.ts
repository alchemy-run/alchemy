import * as organizations from "@distilled.cloud/aws/organizations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `organizations:ListAccounts`.
 *
 * Lists all accounts in the organization — the backbone of cross-account automation that iterates every member account.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListAccountsHttp)`.
 * ### Reading the Organization Tree
 * **Example:** Iterate Every Account
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAccounts = yield* AWS.Organizations.ListAccounts();
 *
 * // runtime
 * const { Accounts } = yield* listAccounts();
 * ```
 *
 * @binding
 */
export interface ListAccounts extends Binding.Service<
  ListAccounts,
  "AWS.Organizations.ListAccounts",
  () => Effect.Effect<
    (
      request?: organizations.ListAccountsRequest,
    ) => Effect.Effect<organizations.ListAccountsResponse, organizations.ListAccountsError>
  >
> {}
export const ListAccounts = Binding.Service<ListAccounts>("AWS.Organizations.ListAccounts");

export const ListAccountsHttp = Layer.effect(
  ListAccounts,
  makeOrganizationsHttpBinding({
    capability: "ListAccounts",
    iamActions: ["organizations:ListAccounts"],
    operation: organizations.listAccounts,
  }),
);
