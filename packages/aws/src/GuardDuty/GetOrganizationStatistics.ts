import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGuardDutyAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `guardduty:GetOrganizationStatistics`.
 *
 * Reports organization-wide GuardDuty enablement statistics (delegated administrator only).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetOrganizationStatisticsHttp)`.
 * ### Organization Administration
 * **Example:** Read Org Statistics
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const getOrganizationStatistics = yield* AWS.GuardDuty.GetOrganizationStatistics();
 *
 * // runtime
 * const { OrganizationDetails } = yield* getOrganizationStatistics();
 * ```
 *
 * @binding
 */
export interface GetOrganizationStatistics extends Binding.Service<
  GetOrganizationStatistics,
  "AWS.GuardDuty.GetOrganizationStatistics",
  () => Effect.Effect<
    (
      request?: guardduty.GetOrganizationStatisticsRequest,
    ) => Effect.Effect<
      guardduty.GetOrganizationStatisticsResponse,
      guardduty.GetOrganizationStatisticsError
    >
  >
> {}
export const GetOrganizationStatistics = Binding.Service<GetOrganizationStatistics>(
  "AWS.GuardDuty.GetOrganizationStatistics",
);

export const GetOrganizationStatisticsHttp = Layer.effect(
  GetOrganizationStatistics,
  makeGuardDutyAccountHttpBinding({
    tag: "AWS.GuardDuty.GetOrganizationStatistics",
    operation: guardduty.getOrganizationStatistics,
    actions: ["guardduty:GetOrganizationStatistics"],
  }),
);
