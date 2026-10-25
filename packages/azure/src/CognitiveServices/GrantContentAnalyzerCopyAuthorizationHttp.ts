import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GrantContentAnalyzerCopyAuthorization } from "./GrantContentAnalyzerCopyAuthorization.ts";

/**
 * Implementation of {@link GrantContentAnalyzerCopyAuthorization} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzerGrantCopyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GrantContentAnalyzerCopyAuthorization
 */
export const GrantContentAnalyzerCopyAuthorizationHttp = Layer.effect(
  GrantContentAnalyzerCopyAuthorization,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GrantContentAnalyzerCopyAuthorization",
    operation: cu.ContentAnalyzersGrantCopyAuthorization,
    grant: AIRole.ContentAnalyzerGrantCopy,
  }),
);
