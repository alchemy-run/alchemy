import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AnalyzeDocumentFromStream } from "./AnalyzeDocumentFromStream.ts";

/**
 * Implementation of {@link AnalyzeDocumentFromStream} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentAnalyzeRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeDocumentFromStream
 */
export const AnalyzeDocumentFromStreamHttp = Layer.effect(
  AnalyzeDocumentFromStream,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeDocumentFromStream",
    operation: documents.DocumentModelsAnalyzeDocumentFromStream,
    grant: AIRole.DocumentAnalyze,
  }),
);
