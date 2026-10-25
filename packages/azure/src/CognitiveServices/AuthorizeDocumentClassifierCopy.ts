import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AuthorizeDocumentClassifierCopyRequest extends Omit<
  documents.DocumentClassifiersAuthorizeClassifierCopyRequest,
  "endpoint"
> {}

/**
 * Generates authorization to copy a document classifier to this location
 * with specified classifierId and optional description.
 *
 * Binding assigns a custom role
 * (`AzureAIDocumentClassifiersAuthorizeCopyRole`, one per stack) with
 * exactly the data action
 * `FormRecognizer/documentclassifiers:authorizecopy/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AuthorizeDocumentClassifierCopyHttp}.
 *
 * ### Calling AuthorizeDocumentClassifierCopy
 * **Example:** AuthorizeDocumentClassifierCopy from a Function
 * ```typescript
 * // init
 * const authorizeDocumentClassifierCopy = yield* Azure.CognitiveServices.AuthorizeDocumentClassifierCopy(account);
 *
 * // runtime
 * const result = yield* authorizeDocumentClassifierCopy({ classifierId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AuthorizeDocumentClassifierCopy extends Binding.Service<
  AuthorizeDocumentClassifierCopy,
  "Azure.CognitiveServices.AuthorizeDocumentClassifierCopy",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AuthorizeDocumentClassifierCopyRequest,
    ) => Effect.Effect<
      documents.ClassifierCopyAuthorization,
      documents.DocumentClassifiersAuthorizeClassifierCopyError,
      RuntimeContext
    >
  >
> {}

export const AuthorizeDocumentClassifierCopy = Binding.Service<AuthorizeDocumentClassifierCopy>(
  "Azure.CognitiveServices.AuthorizeDocumentClassifierCopy",
);
