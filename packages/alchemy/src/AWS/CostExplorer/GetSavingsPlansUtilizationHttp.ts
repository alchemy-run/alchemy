import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetSavingsPlansUtilization } from "./GetSavingsPlansUtilization.ts";

export const GetSavingsPlansUtilizationHttp = Layer.effect(
  GetSavingsPlansUtilization,
  makeCostExplorerHttpBinding<
    ce.GetSavingsPlansUtilizationRequest,
    ce.GetSavingsPlansUtilizationResponse,
    ce.GetSavingsPlansUtilizationError
  >({
    capability: "GetSavingsPlansUtilization",
    iamActions: ["ce:GetSavingsPlansUtilization"],
    operation: ce.getSavingsPlansUtilization,
  }),
);
