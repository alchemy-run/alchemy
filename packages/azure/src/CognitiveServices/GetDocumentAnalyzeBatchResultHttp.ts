import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentAnalyzeBatchResult } from "./GetDocumentAnalyzeBatchResult.ts";

/**
 * Implementation of {@link GetDocumentAnalyzeBatchResult} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeBatchResultsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentAnalyzeBatchResult
 */
export const GetDocumentAnalyzeBatchResultHttp = Layer.effect(
  GetDocumentAnalyzeBatchResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentAnalyzeBatchResult",
    operation: documents.GetDocumentModelAnalyzeBatchResult,
    grant: AIRole.DocumentAnalyzeBatchResultsRead,
  }),
);
