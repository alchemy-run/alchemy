import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteDocumentClassifier } from "./DeleteDocumentClassifier.ts";

/**
 * Implementation of {@link DeleteDocumentClassifier} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifiersDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteDocumentClassifier
 */
export const DeleteDocumentClassifierHttp = Layer.effect(
  DeleteDocumentClassifier,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteDocumentClassifier",
    operation: documents.DeleteDocumentClassifierClassifier,
    grant: AIRole.DocumentClassifiersDelete,
  }),
);
