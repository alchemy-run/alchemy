import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetContentAnalyzerResult } from "./GetContentAnalyzerResult.ts";

/**
 * Implementation of {@link GetContentAnalyzerResult} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentResultsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetContentAnalyzerResult
 */
export const GetContentAnalyzerResultHttp = Layer.effect(
  GetContentAnalyzerResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetContentAnalyzerResult",
    operation: cu.GetContentAnalyzerResult,
    grant: AIRole.ContentResultsRead,
  }),
);
