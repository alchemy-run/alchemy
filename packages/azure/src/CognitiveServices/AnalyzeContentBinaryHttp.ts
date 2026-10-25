import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AnalyzeContentBinary } from "./AnalyzeContentBinary.ts";

/**
 * Implementation of {@link AnalyzeContentBinary} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzeBinaryRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeContentBinary
 */
export const AnalyzeContentBinaryHttp = Layer.effect(
  AnalyzeContentBinary,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeContentBinary",
    operation: cu.ContentAnalyzersAnalyzeBinary,
    grant: AIRole.ContentAnalyzeBinary,
  }),
);
