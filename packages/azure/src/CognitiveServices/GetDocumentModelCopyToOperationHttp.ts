import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentModelCopyToOperation } from "./GetDocumentModelCopyToOperation.ts";

/**
 * Implementation of {@link GetDocumentModelCopyToOperation} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentOperationsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentModelCopyToOperation
 */
export const GetDocumentModelCopyToOperationHttp = Layer.effect(
  GetDocumentModelCopyToOperation,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentModelCopyToOperation",
    operation: documents.MiscellaneousOperationsGetDocumentModelCopyToOperation,
    grant: AIRole.DocumentOperationsRead,
  }),
);
