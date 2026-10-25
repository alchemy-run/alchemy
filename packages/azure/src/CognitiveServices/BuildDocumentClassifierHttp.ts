import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { BuildDocumentClassifier } from "./BuildDocumentClassifier.ts";

/**
 * Implementation of {@link BuildDocumentClassifier} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifiersBuildRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.BuildDocumentClassifier
 */
export const BuildDocumentClassifierHttp = Layer.effect(
  BuildDocumentClassifier,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.BuildDocumentClassifier",
    operation: documents.DocumentClassifiersBuildClassifier,
    grant: AIRole.DocumentClassifiersBuild,
  }),
);
