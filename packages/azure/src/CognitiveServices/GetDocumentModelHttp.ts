import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentModel } from "./GetDocumentModel.ts";

/**
 * Implementation of {@link GetDocumentModel} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentModelsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentModel
 */
export const GetDocumentModelHttp = Layer.effect(
  GetDocumentModel,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentModel",
    operation: documents.GetDocumentModelModel,
    grant: AIRole.DocumentModelsRead,
  }),
);
