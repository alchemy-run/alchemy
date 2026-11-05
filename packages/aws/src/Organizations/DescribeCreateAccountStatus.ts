import * as organizations from "@distilled.cloud/aws/organizations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `organizations:DescribeCreateAccountStatus`.
 *
 * Retrieves the current status of an asynchronous account-creation request — the polling half of an account-vending workflow.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.DescribeCreateAccountStatusHttp)`.
 * ### Account Vending
 * **Example:** Poll an Account-Creation Request
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeCreateAccountStatus = yield* AWS.Organizations.DescribeCreateAccountStatus();
 *
 * // runtime
 * const { CreateAccountStatus } = yield* describeCreateAccountStatus({
 *   CreateAccountRequestId: requestId,
 * });
 * ```
 *
 * @binding
 */
export interface DescribeCreateAccountStatus extends Binding.Service<
  DescribeCreateAccountStatus,
  "AWS.Organizations.DescribeCreateAccountStatus",
  () => Effect.Effect<
    (
      request: organizations.DescribeCreateAccountStatusRequest,
    ) => Effect.Effect<
      organizations.DescribeCreateAccountStatusResponse,
      organizations.DescribeCreateAccountStatusError
    >
  >
> {}
export const DescribeCreateAccountStatus = Binding.Service<DescribeCreateAccountStatus>(
  "AWS.Organizations.DescribeCreateAccountStatus",
);

export const DescribeCreateAccountStatusHttp = Layer.effect(
  DescribeCreateAccountStatus,
  makeOrganizationsHttpBinding({
    capability: "DescribeCreateAccountStatus",
    iamActions: ["organizations:DescribeCreateAccountStatus"],
    operation: organizations.describeCreateAccountStatus,
  }),
);
