import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListDocumentClassifiersRequest extends Omit<
  documents.ListDocumentClassifierClassifiersRequest,
  "endpoint"
> {}

/**
 * List all document classifiers.
 *
 * Binding assigns a custom role (`AzureAIDocumentClassifiersReadRole`, one
 * per stack) with exactly the data action
 * `FormRecognizer/documentclassifiers/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListDocumentClassifiersHttp}.
 *
 * ### Calling ListDocumentClassifiers
 * **Example:** ListDocumentClassifiers from a Function
 * ```typescript
 * // init
 * const listDocumentClassifiers = yield* Azure.CognitiveServices.ListDocumentClassifiers(account);
 *
 * // runtime
 * const result = yield* listDocumentClassifiers();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListDocumentClassifiers extends Binding.Service<
  ListDocumentClassifiers,
  "Azure.CognitiveServices.ListDocumentClassifiers",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListDocumentClassifiersRequest,
    ) => Effect.Effect<
      documents.PagedDocumentClassifierDetails,
      documents.ListDocumentClassifierClassifiersError,
      RuntimeContext
    >
  >
> {}

export const ListDocumentClassifiers = Binding.Service<ListDocumentClassifiers>(
  "Azure.CognitiveServices.ListDocumentClassifiers",
);
