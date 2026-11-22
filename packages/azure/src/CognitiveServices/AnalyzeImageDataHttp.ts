import * as vision from "@distilled.cloud/azure/ai-image-analysis";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AnalyzeImageData } from "./AnalyzeImageData.ts";

/**
 * Implementation of {@link AnalyzeImageData} over the distilled `ai-image-analysis`
 * data plane. Assigns the custom `AzureAIImageAnalysisRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeImageData
 */
export const AnalyzeImageDataHttp = Layer.effect(
  AnalyzeImageData,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeImageData",
    operation: vision.AnalyzeFromImageData,
    grant: AIRole.ImageAnalysis,
  }),
);
