import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentClassifierCopyToOperation } from "./GetDocumentClassifierCopyToOperation.ts";

/**
 * Implementation of {@link GetDocumentClassifierCopyToOperation} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentOperationsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentClassifierCopyToOperation
 */
export const GetDocumentClassifierCopyToOperationHttp = Layer.effect(
  GetDocumentClassifierCopyToOperation,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentClassifierCopyToOperation",
    operation: documents.MiscellaneousOperationsGetDocumentClassifierCopyToOperation,
    grant: AIRole.DocumentOperationsRead,
  }),
);
