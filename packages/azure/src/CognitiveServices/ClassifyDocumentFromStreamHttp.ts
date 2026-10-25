import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ClassifyDocumentFromStream } from "./ClassifyDocumentFromStream.ts";

/**
 * Implementation of {@link ClassifyDocumentFromStream} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ClassifyDocumentFromStream
 */
export const ClassifyDocumentFromStreamHttp = Layer.effect(
  ClassifyDocumentFromStream,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ClassifyDocumentFromStream",
    operation: documents.DocumentClassifiersClassifyDocumentFromStream,
    grant: AIRole.DocumentClassify,
  }),
);
