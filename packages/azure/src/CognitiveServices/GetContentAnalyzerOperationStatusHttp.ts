import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetContentAnalyzerOperationStatus } from "./GetContentAnalyzerOperationStatus.ts";

/**
 * Implementation of {@link GetContentAnalyzerOperationStatus} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzerOperationsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetContentAnalyzerOperationStatus
 */
export const GetContentAnalyzerOperationStatusHttp = Layer.effect(
  GetContentAnalyzerOperationStatus,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetContentAnalyzerOperationStatus",
    operation: cu.GetContentAnalyzerOperationStatus,
    grant: AIRole.ContentAnalyzerOperationsRead,
  }),
);
