import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentModelBuildOperation } from "./GetDocumentModelBuildOperation.ts";

/**
 * Implementation of {@link GetDocumentModelBuildOperation} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentOperationsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentModelBuildOperation
 */
export const GetDocumentModelBuildOperationHttp = Layer.effect(
  GetDocumentModelBuildOperation,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentModelBuildOperation",
    operation: documents.GetMiscellaneousOperationDocumentModelBuildOperation,
    grant: AIRole.DocumentOperationsRead,
  }),
);
