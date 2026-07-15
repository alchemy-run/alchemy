import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { StartCommitmentPurchaseAnalysis } from "./StartCommitmentPurchaseAnalysis.ts";

export const StartCommitmentPurchaseAnalysisHttp = Layer.effect(
  StartCommitmentPurchaseAnalysis,
  makeCostExplorerHttpBinding<
    ce.StartCommitmentPurchaseAnalysisRequest,
    ce.StartCommitmentPurchaseAnalysisResponse,
    ce.StartCommitmentPurchaseAnalysisError
  >({
    capability: "StartCommitmentPurchaseAnalysis",
    iamActions: ["ce:StartCommitmentPurchaseAnalysis"],
    operation: ce.startCommitmentPurchaseAnalysis,
  }),
);
