import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentClassifier } from "./GetDocumentClassifier.ts";

/**
 * Implementation of {@link GetDocumentClassifier} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifiersReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentClassifier
 */
export const GetDocumentClassifierHttp = Layer.effect(
  GetDocumentClassifier,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentClassifier",
    operation: documents.GetDocumentClassifierClassifier,
    grant: AIRole.DocumentClassifiersRead,
  }),
);
