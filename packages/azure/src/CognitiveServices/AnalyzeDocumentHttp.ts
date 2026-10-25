import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AnalyzeDocument } from "./AnalyzeDocument.ts";

/**
 * Implementation of {@link AnalyzeDocument} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeDocument
 */
export const AnalyzeDocumentHttp = Layer.effect(
  AnalyzeDocument,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeDocument",
    operation: documents.DocumentModelsAnalyzeDocument,
    grant: AIRole.DocumentAnalyze,
  }),
);
