import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteContentAnalyzer } from "./DeleteContentAnalyzer.ts";

/**
 * Implementation of {@link DeleteContentAnalyzer} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzersDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteContentAnalyzer
 */
export const DeleteContentAnalyzerHttp = Layer.effect(
  DeleteContentAnalyzer,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteContentAnalyzer",
    operation: cu.DeleteContentAnalyzer,
    grant: AIRole.ContentAnalyzersDelete,
  }),
);
