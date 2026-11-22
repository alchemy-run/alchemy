import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentAnalyzeResult } from "./GetDocumentAnalyzeResult.ts";

/**
 * Implementation of {@link GetDocumentAnalyzeResult} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeResultsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentAnalyzeResult
 */
export const GetDocumentAnalyzeResultHttp = Layer.effect(
  GetDocumentAnalyzeResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentAnalyzeResult",
    operation: documents.GetDocumentModelAnalyzeResult,
    grant: AIRole.DocumentAnalyzeResultsRead,
  }),
);
