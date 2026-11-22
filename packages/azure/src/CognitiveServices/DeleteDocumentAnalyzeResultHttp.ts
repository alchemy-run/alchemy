import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteDocumentAnalyzeResult } from "./DeleteDocumentAnalyzeResult.ts";

/**
 * Implementation of {@link DeleteDocumentAnalyzeResult} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeResultsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteDocumentAnalyzeResult
 */
export const DeleteDocumentAnalyzeResultHttp = Layer.effect(
  DeleteDocumentAnalyzeResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteDocumentAnalyzeResult",
    operation: documents.DeleteDocumentModelAnalyzeResult,
    grant: AIRole.DocumentAnalyzeResults,
  }),
);
