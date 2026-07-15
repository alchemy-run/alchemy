import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { ListSavingsPlansPurchaseRecommendationGeneration } from "./ListSavingsPlansPurchaseRecommendationGeneration.ts";

export const ListSavingsPlansPurchaseRecommendationGenerationHttp =
  Layer.effect(
    ListSavingsPlansPurchaseRecommendationGeneration,
    makeCostExplorerHttpBinding<
      ce.ListSavingsPlansPurchaseRecommendationGenerationRequest,
      ce.ListSavingsPlansPurchaseRecommendationGenerationResponse,
      ce.ListSavingsPlansPurchaseRecommendationGenerationError
    >({
      capability: "ListSavingsPlansPurchaseRecommendationGeneration",
      iamActions: ["ce:ListSavingsPlansPurchaseRecommendationGeneration"],
      operation: ce.listSavingsPlansPurchaseRecommendationGeneration,
    }),
  );
