import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AnalyzeDocumentBatch } from "./AnalyzeDocumentBatch.ts";

/**
 * Implementation of {@link AnalyzeDocumentBatch} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeBatchRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeDocumentBatch
 */
export const AnalyzeDocumentBatchHttp = Layer.effect(
  AnalyzeDocumentBatch,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeDocumentBatch",
    operation: documents.DocumentModelsAnalyzeBatchDocuments,
    grant: AIRole.DocumentAnalyzeBatch,
  }),
);
