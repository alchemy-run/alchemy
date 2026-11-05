import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link GetRightsizingRecommendation}.
 */
export interface GetRightsizingRecommendationRequest
  extends ce.GetRightsizingRecommendationRequest {}

/**
 * Runtime binding for `ce:GetRightsizingRecommendation`.
 *
 * Get recommendations for idle and underutilized EC2 instances —
 * terminate or downsize suggestions with estimated savings. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetRightsizingRecommendationHttp)`.
 * ### Rightsizing
 * **Example:** Get EC2 Rightsizing Recommendations
 * ```typescript
 * // init — account-level binding takes no resource
 * const getRightsizingRecommendation = yield* AWS.CostExplorer.GetRightsizingRecommendation();
 *
 * // runtime
 * const result = yield* getRightsizingRecommendation({
 *   Service: "AmazonEC2",
 * });
 * const recommendations = result.RightsizingRecommendations;
 * ```
 *
 * @binding
 */
export interface GetRightsizingRecommendation extends Binding.Service<
  GetRightsizingRecommendation,
  "AWS.CostExplorer.GetRightsizingRecommendation",
  () => Effect.Effect<
    (
      request: GetRightsizingRecommendationRequest,
    ) => Effect.Effect<
      ce.GetRightsizingRecommendationResponse,
      ce.GetRightsizingRecommendationError
    >
  >
> {}

export const GetRightsizingRecommendation = Binding.Service<GetRightsizingRecommendation>(
  "AWS.CostExplorer.GetRightsizingRecommendation",
);

export const GetRightsizingRecommendationHttp = Layer.effect(
  GetRightsizingRecommendation,
  makeCostExplorerHttpBinding({
    capability: "GetRightsizingRecommendation",
    iamActions: ["ce:GetRightsizingRecommendation"],
    operation: ce.getRightsizingRecommendation,
  }),
);
