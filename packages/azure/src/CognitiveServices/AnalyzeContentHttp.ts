import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AnalyzeContent } from "./AnalyzeContent.ts";

/**
 * Implementation of {@link AnalyzeContent} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzeRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeContent
 */
export const AnalyzeContentHttp = Layer.effect(
  AnalyzeContent,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeContent",
    operation: cu.ContentAnalyzersAnalyze,
    grant: AIRole.ContentAnalyze,
  }),
);
