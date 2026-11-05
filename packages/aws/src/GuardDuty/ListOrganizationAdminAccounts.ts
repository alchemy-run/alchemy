import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `guardduty:ListOrganizationAdminAccounts`.
 *
 * Lists the accounts delegated as GuardDuty administrator for the organization.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.ListOrganizationAdminAccountsHttp)`.
 * ### Organization Administration
 * **Example:** List Delegated Administrators
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const listOrganizationAdminAccounts = yield* AWS.GuardDuty.ListOrganizationAdminAccounts();
 *
 * // runtime
 * const { AdminAccounts } = yield* listOrganizationAdminAccounts();
 * ```
 *
 * @binding
 */
export interface ListOrganizationAdminAccounts extends Binding.Service<
  ListOrganizationAdminAccounts,
  "AWS.GuardDuty.ListOrganizationAdminAccounts",
  () => Effect.Effect<
    (
      request?: guardduty.ListOrganizationAdminAccountsRequest,
    ) => Effect.Effect<
      guardduty.ListOrganizationAdminAccountsResponse,
      guardduty.ListOrganizationAdminAccountsError
    >
  >
> {}
export const ListOrganizationAdminAccounts = Binding.Service<ListOrganizationAdminAccounts>(
  "AWS.GuardDuty.ListOrganizationAdminAccounts",
);

export const ListOrganizationAdminAccountsHttp = Layer.effect(
  ListOrganizationAdminAccounts,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.ListOrganizationAdminAccounts",
    operation: guardduty.listOrganizationAdminAccounts,
    actions: ["guardduty:ListOrganizationAdminAccounts"],
  }),
);
