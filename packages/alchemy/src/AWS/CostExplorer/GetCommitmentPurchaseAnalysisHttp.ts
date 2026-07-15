import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetCommitmentPurchaseAnalysis } from "./GetCommitmentPurchaseAnalysis.ts";

export const GetCommitmentPurchaseAnalysisHttp = Layer.effect(
  GetCommitmentPurchaseAnalysis,
  makeCostExplorerHttpBinding<
    ce.GetCommitmentPurchaseAnalysisRequest,
    ce.GetCommitmentPurchaseAnalysisResponse,
    ce.GetCommitmentPurchaseAnalysisError
  >({
    capability: "GetCommitmentPurchaseAnalysis",
    iamActions: ["ce:GetCommitmentPurchaseAnalysis"],
    operation: ce.getCommitmentPurchaseAnalysis,
  }),
);
