import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetDocumentIntelligenceResourceDetails } from "./GetDocumentIntelligenceResourceDetails.ts";

/**
 * Implementation of {@link GetDocumentIntelligenceResourceDetails} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentInfoReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetDocumentIntelligenceResourceDetails
 */
export const GetDocumentIntelligenceResourceDetailsHttp = Layer.effect(
  GetDocumentIntelligenceResourceDetails,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetDocumentIntelligenceResourceDetails",
    operation: documents.GetMiscellaneousOperationResourceDetails,
    grant: AIRole.DocumentInfoRead,
  }),
);
