import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { ComposeDocumentModel } from "./ComposeDocumentModel.ts";

/**
 * Implementation of {@link ComposeDocumentModel} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentModelsComposeRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ComposeDocumentModel
 */
export const ComposeDocumentModelHttp = Layer.effect(
  ComposeDocumentModel,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.ComposeDocumentModel",
    operation: documents.DocumentModelsComposeModel,
    grant: AIRole.DocumentModelsCompose,
  }),
);
