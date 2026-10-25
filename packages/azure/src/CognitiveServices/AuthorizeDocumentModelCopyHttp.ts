import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AuthorizeDocumentModelCopy } from "./AuthorizeDocumentModelCopy.ts";

/**
 * Implementation of {@link AuthorizeDocumentModelCopy} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentModelsAuthorizeCopyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AuthorizeDocumentModelCopy
 */
export const AuthorizeDocumentModelCopyHttp = Layer.effect(
  AuthorizeDocumentModelCopy,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AuthorizeDocumentModelCopy",
    operation: documents.DocumentModelsAuthorizeModelCopy,
    grant: AIRole.DocumentModelsAuthorizeCopy,
  }),
);
