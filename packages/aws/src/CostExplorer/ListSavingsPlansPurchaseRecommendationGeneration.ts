import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link ListSavingsPlansPurchaseRecommendationGeneration}.
 */
export interface ListSavingsPlansPurchaseRecommendationGenerationRequest
  extends ce.ListSavingsPlansPurchaseRecommendationGenerationRequest {}

/**
 * Runtime binding for `ce:ListSavingsPlansPurchaseRecommendationGeneration`.
 *
 * List your Savings Plans recommendation generations from the past
 * 30 days with their status. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.ListSavingsPlansPurchaseRecommendationGenerationHttp)`.
 * ### Savings Plans
 * **Example:** List Recent Generations
 * ```typescript
 * // init — account-level binding takes no resource
 * const listSavingsPlansPurchaseRecommendationGeneration = yield* AWS.CostExplorer.ListSavingsPlansPurchaseRecommendationGeneration();
 *
 * // runtime
 * const result = yield* listSavingsPlansPurchaseRecommendationGeneration();
 * const generations = result.GenerationSummaryList;
 * ```
 *
 * @binding
 */
export interface ListSavingsPlansPurchaseRecommendationGeneration extends Binding.Service<
  ListSavingsPlansPurchaseRecommendationGeneration,
  "AWS.CostExplorer.ListSavingsPlansPurchaseRecommendationGeneration",
  () => Effect.Effect<
    (
      request?: ListSavingsPlansPurchaseRecommendationGenerationRequest,
    ) => Effect.Effect<
      ce.ListSavingsPlansPurchaseRecommendationGenerationResponse,
      ce.ListSavingsPlansPurchaseRecommendationGenerationError
    >
  >
> {}

export const ListSavingsPlansPurchaseRecommendationGeneration =
  Binding.Service<ListSavingsPlansPurchaseRecommendationGeneration>(
    "AWS.CostExplorer.ListSavingsPlansPurchaseRecommendationGeneration",
  );

export const ListSavingsPlansPurchaseRecommendationGenerationHttp = Layer.effect(
  ListSavingsPlansPurchaseRecommendationGeneration,
  makeCostExplorerHttpBinding({
    capability: "ListSavingsPlansPurchaseRecommendationGeneration",
    iamActions: ["ce:ListSavingsPlansPurchaseRecommendationGeneration"],
    operation: ce.listSavingsPlansPurchaseRecommendationGeneration,
  }),
);
