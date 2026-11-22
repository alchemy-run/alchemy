import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ListDocumentModels } from "./ListDocumentModels.ts";

/**
 * Implementation of {@link ListDocumentModels} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentModelsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListDocumentModels
 */
export const ListDocumentModelsHttp = Layer.effect(
  ListDocumentModels,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ListDocumentModels",
    operation: documents.ListDocumentModelModels,
    grant: AIRole.DocumentModelsRead,
  }),
);
