import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCostComparisonDrivers } from "./GetCostComparisonDrivers.ts";

export const GetCostComparisonDriversHttp = Layer.effect(
  GetCostComparisonDrivers,
  makeCostExplorerHttpBinding<
    ce.GetCostComparisonDriversRequest,
    ce.GetCostComparisonDriversResponse,
    ce.GetCostComparisonDriversError
  >({
    capability: "GetCostComparisonDrivers",
    iamActions: ["ce:GetCostComparisonDrivers"],
    operation: ce.getCostComparisonDrivers,
  }),
);
