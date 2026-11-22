import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteContentAnalyzerResult } from "./DeleteContentAnalyzerResult.ts";

/**
 * Implementation of {@link DeleteContentAnalyzerResult} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentResultsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteContentAnalyzerResult
 */
export const DeleteContentAnalyzerResultHttp = Layer.effect(
  DeleteContentAnalyzerResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteContentAnalyzerResult",
    operation: cu.DeleteContentAnalyzerResult,
    grant: AIRole.ContentResultsDelete,
  }),
);
