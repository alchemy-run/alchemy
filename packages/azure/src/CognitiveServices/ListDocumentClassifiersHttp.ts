import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListDocumentClassifiers } from "./ListDocumentClassifiers.ts";

/**
 * Implementation of {@link ListDocumentClassifiers} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifiersReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListDocumentClassifiers
 */
export const ListDocumentClassifiersHttp = Layer.effect(
  ListDocumentClassifiers,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListDocumentClassifiers",
    operation: documents.ListDocumentClassifierClassifiers,
    grant: AIRole.DocumentClassifiersRead,
  }),
);
