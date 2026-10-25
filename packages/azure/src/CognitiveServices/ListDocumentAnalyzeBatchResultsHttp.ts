import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListDocumentAnalyzeBatchResults } from "./ListDocumentAnalyzeBatchResults.ts";

/**
 * Implementation of {@link ListDocumentAnalyzeBatchResults} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeBatchResultsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListDocumentAnalyzeBatchResults
 */
export const ListDocumentAnalyzeBatchResultsHttp = Layer.effect(
  ListDocumentAnalyzeBatchResults,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListDocumentAnalyzeBatchResults",
    operation: documents.ListDocumentModelAnalyzeBatchResults,
    grant: AIRole.DocumentAnalyzeBatchResultsRead,
  }),
);
