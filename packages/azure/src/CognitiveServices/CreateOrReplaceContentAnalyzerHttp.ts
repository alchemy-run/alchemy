import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreateOrReplaceContentAnalyzer } from "./CreateOrReplaceContentAnalyzer.ts";

/**
 * Implementation of {@link CreateOrReplaceContentAnalyzer} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzersWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateOrReplaceContentAnalyzer
 */
export const CreateOrReplaceContentAnalyzerHttp = Layer.effect(
  CreateOrReplaceContentAnalyzer,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreateOrReplaceContentAnalyzer",
    operation: cu.ContentAnalyzersCreateOrReplace,
    grant: AIRole.ContentAnalyzersWrite,
  }),
);
