import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCostCategories } from "./GetCostCategories.ts";

export const GetCostCategoriesHttp = Layer.effect(
  GetCostCategories,
  makeCostExplorerHttpBinding<
    ce.GetCostCategoriesRequest,
    ce.GetCostCategoriesResponse,
    ce.GetCostCategoriesError
  >({
    capability: "GetCostCategories",
    iamActions: ["ce:GetCostCategories"],
    operation: ce.getCostCategories,
  }),
);
