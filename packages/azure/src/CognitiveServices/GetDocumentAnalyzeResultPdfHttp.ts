import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentAnalyzeResultPdf } from "./GetDocumentAnalyzeResultPdf.ts";

/**
 * Implementation of {@link GetDocumentAnalyzeResultPdf} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeResultPdfReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentAnalyzeResultPdf
 */
export const GetDocumentAnalyzeResultPdfHttp = Layer.effect(
  GetDocumentAnalyzeResultPdf,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentAnalyzeResultPdf",
    operation: documents.GetDocumentModelAnalyzeResultPdf,
    grant: AIRole.DocumentAnalyzeResultPdfRead,
  }),
);
