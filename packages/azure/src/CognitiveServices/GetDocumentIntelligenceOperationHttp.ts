import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentIntelligenceOperation } from "./GetDocumentIntelligenceOperation.ts";

/**
 * Implementation of {@link GetDocumentIntelligenceOperation} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentOperationsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentIntelligenceOperation
 */
export const GetDocumentIntelligenceOperationHttp = Layer.effect(
  GetDocumentIntelligenceOperation,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentIntelligenceOperation",
    operation: documents.GetMiscellaneousOperationOperation,
    grant: AIRole.DocumentOperationsRead,
  }),
);
