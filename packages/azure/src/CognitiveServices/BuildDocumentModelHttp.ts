import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { BuildDocumentModel } from "./BuildDocumentModel.ts";

/**
 * Implementation of {@link BuildDocumentModel} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentModelsBuildRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.BuildDocumentModel
 */
export const BuildDocumentModelHttp = Layer.effect(
  BuildDocumentModel,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.BuildDocumentModel",
    operation: documents.DocumentModelsBuildModel,
    grant: AIRole.DocumentModelsBuild,
  }),
);
