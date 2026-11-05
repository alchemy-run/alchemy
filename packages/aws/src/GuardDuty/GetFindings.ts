import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetFindings`.
 *
 * Hydrates full finding details for a batch of finding ids returned by `ListFindings`.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetFindingsHttp)`.
 * ### Working with Findings
 * **Example:** Hydrate Finding Details
 * ```typescript
 * // init
 * const getFindings = yield* AWS.GuardDuty.GetFindings(detector);
 *
 * // runtime
 * const { Findings } = yield* getFindings({ FindingIds: findingIds });
 * ```
 *
 * @binding
 */
export interface GetFindings extends Binding.Service<
  GetFindings,
  "AWS.GuardDuty.GetFindings",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.GetFindingsRequest, "DetectorId">,
    ) => Effect.Effect<guardduty.GetFindingsResponse, guardduty.GetFindingsError>
  >
> {}
export const GetFindings = Binding.Service<GetFindings>("AWS.GuardDuty.GetFindings");

export const GetFindingsHttp = Layer.effect(
  GetFindings,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.GetFindings",
    operation: guardduty.getFindings,
    actions: ["guardduty:GetFindings"],
  }),
);
