import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteDocumentModel } from "./DeleteDocumentModel.ts";

/**
 * Implementation of {@link DeleteDocumentModel} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentModelsDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteDocumentModel
 */
export const DeleteDocumentModelHttp = Layer.effect(
  DeleteDocumentModel,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteDocumentModel",
    operation: documents.DeleteDocumentModelModel,
    grant: AIRole.DocumentModelsDelete,
  }),
);
