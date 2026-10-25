import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentModelComposeOperation } from "./GetDocumentModelComposeOperation.ts";

/**
 * Implementation of {@link GetDocumentModelComposeOperation} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentOperationsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentModelComposeOperation
 */
export const GetDocumentModelComposeOperationHttp = Layer.effect(
  GetDocumentModelComposeOperation,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentModelComposeOperation",
    operation: documents.GetMiscellaneousOperationDocumentModelComposeOperation,
    grant: AIRole.DocumentOperationsRead,
  }),
);
