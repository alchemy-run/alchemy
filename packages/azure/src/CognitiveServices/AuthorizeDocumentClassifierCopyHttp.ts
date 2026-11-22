import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { AuthorizeDocumentClassifierCopy } from "./AuthorizeDocumentClassifierCopy.ts";

/**
 * Implementation of {@link AuthorizeDocumentClassifierCopy} over the distilled `ai-document-intelligence`
 * data plane. Assigns the custom `AzureAIDocumentClassifiersAuthorizeCopyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AuthorizeDocumentClassifierCopy
 */
export const AuthorizeDocumentClassifierCopyHttp = Layer.effect(
  AuthorizeDocumentClassifierCopy,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AuthorizeDocumentClassifierCopy",
    operation: documents.DocumentClassifiersAuthorizeClassifierCopy,
    grant: AIRole.DocumentClassifiersAuthorizeCopy,
  }),
);
