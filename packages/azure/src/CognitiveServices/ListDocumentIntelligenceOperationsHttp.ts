import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListDocumentIntelligenceOperations } from "./ListDocumentIntelligenceOperations.ts";

/**
 * Implementation of {@link ListDocumentIntelligenceOperations} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentOperationsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListDocumentIntelligenceOperations
 */
export const ListDocumentIntelligenceOperationsHttp = Layer.effect(
  ListDocumentIntelligenceOperations,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListDocumentIntelligenceOperations",
    operation: documents.ListMiscellaneousOperationOperations,
    grant: AIRole.DocumentOperationsRead,
  }),
);
