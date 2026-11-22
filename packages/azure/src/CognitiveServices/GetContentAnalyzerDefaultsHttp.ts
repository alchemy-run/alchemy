import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetContentAnalyzerDefaults } from "./GetContentAnalyzerDefaults.ts";

/**
 * Implementation of {@link GetContentAnalyzerDefaults} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentDefaultsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetContentAnalyzerDefaults
 */
export const GetContentAnalyzerDefaultsHttp = Layer.effect(
  GetContentAnalyzerDefaults,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetContentAnalyzerDefaults",
    operation: cu.GetContentAnalyzerDefaults,
    grant: AIRole.ContentDefaultsRead,
  }),
);
