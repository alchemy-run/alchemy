import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentClassifierBuildOperation } from "./GetDocumentClassifierBuildOperation.ts";

/**
 * Implementation of {@link GetDocumentClassifierBuildOperation} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentOperationsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentClassifierBuildOperation
 */
export const GetDocumentClassifierBuildOperationHttp = Layer.effect(
  GetDocumentClassifierBuildOperation,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentClassifierBuildOperation",
    operation: documents.GetMiscellaneousOperationDocumentClassifierBuildOperation,
    grant: AIRole.DocumentOperationsRead,
  }),
);
