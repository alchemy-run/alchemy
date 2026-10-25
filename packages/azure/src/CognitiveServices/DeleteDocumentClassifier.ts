import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteDocumentClassifierRequest extends Omit<
  documents.DeleteDocumentClassifierClassifierRequest,
  "endpoint"
> {}

/**
 * Deletes document classifier.
 *
 * Binding assigns a custom role (`AzureAIDocumentClassifiersDeleteRole`, one
 * per stack) with exactly the data action
 * `FormRecognizer/documentclassifiers/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteDocumentClassifierHttp}.
 *
 * ### Calling DeleteDocumentClassifier
 * **Example:** DeleteDocumentClassifier from a Function
 * ```typescript
 * // init
 * const deleteDocumentClassifier = yield* Azure.CognitiveServices.DeleteDocumentClassifier(account);
 *
 * // runtime
 * const result = yield* deleteDocumentClassifier({ classifierId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteDocumentClassifier extends Binding.Service<
  DeleteDocumentClassifier,
  "Azure.CognitiveServices.DeleteDocumentClassifier",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteDocumentClassifierRequest,
    ) => Effect.Effect<
      documents.DeleteDocumentClassifierClassifierResponse,
      documents.DeleteDocumentClassifierClassifierError,
      RuntimeContext
    >
  >
> {}

export const DeleteDocumentClassifier = Binding.Service<DeleteDocumentClassifier>(
  "Azure.CognitiveServices.DeleteDocumentClassifier",
);
