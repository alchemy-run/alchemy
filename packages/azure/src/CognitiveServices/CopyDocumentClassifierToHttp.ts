import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CopyDocumentClassifierTo } from "./CopyDocumentClassifierTo.ts";

/**
 * Implementation of {@link CopyDocumentClassifierTo} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifiersCopyToRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CopyDocumentClassifierTo
 */
export const CopyDocumentClassifierToHttp = Layer.effect(
  CopyDocumentClassifierTo,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CopyDocumentClassifierTo",
    operation: documents.CopyDocumentClassifierClassifierTo,
    grant: AIRole.DocumentClassifiersCopyTo,
  }),
);
