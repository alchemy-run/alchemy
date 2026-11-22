import * as vision from "@distilled.cloud/azure/ai-image-analysis";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AnalyzeImageFromUrl } from "./AnalyzeImageFromUrl.ts";

/**
 * Implementation of {@link AnalyzeImageFromUrl} over the distilled `ai-image-analysis`
 * data plane. Assigns the custom `AzureAIImageAnalysisRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeImageFromUrl
 */
export const AnalyzeImageFromUrlHttp = Layer.effect(
  AnalyzeImageFromUrl,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeImageFromUrl",
    operation: vision.AnalyzeFromUrl,
    grant: AIRole.ImageAnalysis,
  }),
);
