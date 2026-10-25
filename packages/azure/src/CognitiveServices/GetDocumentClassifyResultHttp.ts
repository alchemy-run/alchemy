import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentClassifyResult } from "./GetDocumentClassifyResult.ts";

/**
 * Implementation of {@link GetDocumentClassifyResult} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifyResultsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentClassifyResult
 */
export const GetDocumentClassifyResultHttp = Layer.effect(
  GetDocumentClassifyResult,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentClassifyResult",
    operation: documents.GetDocumentClassifierClassifyResult,
    grant: AIRole.DocumentClassifyResultsRead,
  }),
);
