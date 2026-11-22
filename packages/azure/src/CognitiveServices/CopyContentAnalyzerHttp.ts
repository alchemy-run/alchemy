import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CopyContentAnalyzer } from "./CopyContentAnalyzer.ts";

/**
 * Implementation of {@link CopyContentAnalyzer} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzerCopyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CopyContentAnalyzer
 */
export const CopyContentAnalyzerHttp = Layer.effect(
  CopyContentAnalyzer,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CopyContentAnalyzer",
    operation: cu.CopyContentAnalyzer,
    grant: AIRole.ContentAnalyzerCopy,
  }),
);
