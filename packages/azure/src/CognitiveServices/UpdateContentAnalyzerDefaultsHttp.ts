import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdateContentAnalyzerDefaults } from "./UpdateContentAnalyzerDefaults.ts";

/**
 * Implementation of {@link UpdateContentAnalyzerDefaults} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentDefaultsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateContentAnalyzerDefaults
 */
export const UpdateContentAnalyzerDefaultsHttp = Layer.effect(
  UpdateContentAnalyzerDefaults,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdateContentAnalyzerDefaults",
    operation: cu.UpdateContentAnalyzerDefaults,
    grant: AIRole.ContentDefaultsWrite,
  }),
);
