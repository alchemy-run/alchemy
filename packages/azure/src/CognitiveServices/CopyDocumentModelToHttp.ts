import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CopyDocumentModelTo } from "./CopyDocumentModelTo.ts";

/**
 * Implementation of {@link CopyDocumentModelTo} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentModelsCopyToRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CopyDocumentModelTo
 */
export const CopyDocumentModelToHttp = Layer.effect(
  CopyDocumentModelTo,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CopyDocumentModelTo",
    operation: documents.CopyDocumentModelModelTo,
    grant: AIRole.DocumentModelsCopyTo,
  }),
);
