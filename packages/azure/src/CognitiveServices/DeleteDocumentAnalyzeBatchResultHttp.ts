import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteDocumentAnalyzeBatchResult } from "./DeleteDocumentAnalyzeBatchResult.ts";

/**
 * Implementation of {@link DeleteDocumentAnalyzeBatchResult} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeBatchResultsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteDocumentAnalyzeBatchResult
 */
export const DeleteDocumentAnalyzeBatchResultHttp = Layer.effect(
  DeleteDocumentAnalyzeBatchResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteDocumentAnalyzeBatchResult",
    operation: documents.DeleteDocumentModelAnalyzeBatchResult,
    grant: AIRole.DocumentAnalyzeBatchResults,
  }),
);
