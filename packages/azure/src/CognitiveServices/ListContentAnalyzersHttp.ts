import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListContentAnalyzers } from "./ListContentAnalyzers.ts";

/**
 * Implementation of {@link ListContentAnalyzers} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentAnalyzersReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListContentAnalyzers
 */
export const ListContentAnalyzersHttp = Layer.effect(
  ListContentAnalyzers,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListContentAnalyzers",
    operation: cu.ListContentAnalyzers,
    grant: AIRole.ContentAnalyzersRead,
  }),
);
