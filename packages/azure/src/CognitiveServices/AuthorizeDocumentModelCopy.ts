import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AuthorizeDocumentModelCopyRequest extends Omit<
  documents.DocumentModelsAuthorizeModelCopyRequest,
  "endpoint"
> {}

/**
 * Generates authorization to copy a document model to this location with
 * specified modelId and optional description.
 *
 * Binding assigns a custom role (`AzureAIDocumentModelsAuthorizeCopyRole`,
 * one per stack) with exactly the data action
 * `FormRecognizer/documentmodels:authorizecopy/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AuthorizeDocumentModelCopyHttp}.
 *
 * ### Calling AuthorizeDocumentModelCopy
 * **Example:** AuthorizeDocumentModelCopy from a Function
 * ```typescript
 * // init
 * const authorizeDocumentModelCopy = yield* Azure.CognitiveServices.AuthorizeDocumentModelCopy(account);
 *
 * // runtime
 * const result = yield* authorizeDocumentModelCopy({ modelId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AuthorizeDocumentModelCopy extends Binding.Service<
  AuthorizeDocumentModelCopy,
  "Azure.CognitiveServices.AuthorizeDocumentModelCopy",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AuthorizeDocumentModelCopyRequest,
    ) => Effect.Effect<
      documents.ModelCopyAuthorization,
      documents.DocumentModelsAuthorizeModelCopyError,
      RuntimeContext
    >
  >
> {}

export const AuthorizeDocumentModelCopy = Binding.Service<AuthorizeDocumentModelCopy>(
  "Azure.CognitiveServices.AuthorizeDocumentModelCopy",
);
