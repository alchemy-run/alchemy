import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `macie2:DisableOrganizationAdminAccount`.
 *
 * Disables an account as the delegated Amazon Macie administrator account for an organization in Organizations.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.DisableOrganizationAdminAccountHttp)`.
 * ### Organization & Members
 * **Example:** Remove the Delegated Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disableOrganizationAdminAccount = yield* AWS.Macie2.DisableOrganizationAdminAccount();
 *
 * // runtime
 * yield* disableOrganizationAdminAccount({ adminAccountId });
 * ```
 *
 * @binding
 */
export interface DisableOrganizationAdminAccount extends Binding.Service<
  DisableOrganizationAdminAccount,
  "AWS.Macie2.DisableOrganizationAdminAccount",
  () => Effect.Effect<
    (
      request?: macie2.DisableOrganizationAdminAccountRequest,
    ) => Effect.Effect<
      macie2.DisableOrganizationAdminAccountResponse,
      macie2.DisableOrganizationAdminAccountError
    >
  >
> {}
export const DisableOrganizationAdminAccount = Binding.Service<DisableOrganizationAdminAccount>(
  "AWS.Macie2.DisableOrganizationAdminAccount",
);

export const DisableOrganizationAdminAccountHttp = Layer.effect(
  DisableOrganizationAdminAccount,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.DisableOrganizationAdminAccount",
    operation: macie2.disableOrganizationAdminAccount,
    actions: ["macie2:DisableOrganizationAdminAccount"],
  }),
);
