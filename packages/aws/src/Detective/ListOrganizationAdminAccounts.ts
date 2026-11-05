import * as detective from "@distilled.cloud/aws/detective";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDetectiveAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `detective:ListOrganizationAdminAccounts`.
 *
 * Lists the organization's delegated Detective administrator account.
 * Callable only from the organization management account.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.ListOrganizationAdminAccountsHttp)`.
 * ### Organization Administration
 * **Example:** Find The Delegated Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listOrganizationAdminAccounts =
 *   yield* AWS.Detective.ListOrganizationAdminAccounts();
 *
 * // runtime
 * const { Administrators } = yield* listOrganizationAdminAccounts();
 * ```
 *
 * @binding
 */
export interface ListOrganizationAdminAccounts extends Binding.Service<
  ListOrganizationAdminAccounts,
  "AWS.Detective.ListOrganizationAdminAccounts",
  () => Effect.Effect<
    (
      request?: detective.ListOrganizationAdminAccountsRequest,
    ) => Effect.Effect<
      detective.ListOrganizationAdminAccountsResponse,
      detective.ListOrganizationAdminAccountsError
    >
  >
> {}
export const ListOrganizationAdminAccounts = Binding.Service<ListOrganizationAdminAccounts>(
  "AWS.Detective.ListOrganizationAdminAccounts",
);

export const ListOrganizationAdminAccountsHttp = Layer.effect(
  ListOrganizationAdminAccounts,
  makeDetectiveAccountHttpBinding({
    tag: "AWS.Detective.ListOrganizationAdminAccounts",
    operation: detective.listOrganizationAdminAccounts,
    actions: ["detective:ListOrganizationAdminAccounts"],
  }),
);
