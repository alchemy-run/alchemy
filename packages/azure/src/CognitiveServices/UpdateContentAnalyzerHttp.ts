import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdateContentAnalyzer } from "./UpdateContentAnalyzer.ts";

/**
 * Implementation of {@link UpdateContentAnalyzer} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzersWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateContentAnalyzer
 */
export const UpdateContentAnalyzerHttp = Layer.effect(
  UpdateContentAnalyzer,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdateContentAnalyzer",
    operation: cu.UpdateContentAnalyzer,
    grant: AIRole.ContentAnalyzersWrite,
  }),
);
