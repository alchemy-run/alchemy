import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetContentAnalyzer } from "./GetContentAnalyzer.ts";

/**
 * Implementation of {@link GetContentAnalyzer} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzersReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetContentAnalyzer
 */
export const GetContentAnalyzerHttp = Layer.effect(
  GetContentAnalyzer,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetContentAnalyzer",
    operation: cu.GetContentAnalyzer,
    grant: AIRole.ContentAnalyzersRead,
  }),
);
