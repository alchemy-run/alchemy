import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentAnalyzeResultFigure } from "./GetDocumentAnalyzeResultFigure.ts";

/**
 * Implementation of {@link GetDocumentAnalyzeResultFigure} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeResultFiguresReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentAnalyzeResultFigure
 */
export const GetDocumentAnalyzeResultFigureHttp = Layer.effect(
  GetDocumentAnalyzeResultFigure,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentAnalyzeResultFigure",
    operation: documents.GetDocumentModelAnalyzeResultFigure,
    grant: AIRole.DocumentAnalyzeResultFiguresRead,
  }),
);
