import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ClassifyDocument } from "./ClassifyDocument.ts";

/**
 * Implementation of {@link ClassifyDocument} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ClassifyDocument
 */
export const ClassifyDocumentHttp = Layer.effect(
  ClassifyDocument,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ClassifyDocument",
    operation: documents.DocumentClassifiersClassifyDocument,
    grant: AIRole.DocumentClassify,
  }),
);
