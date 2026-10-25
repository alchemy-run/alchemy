import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListDocumentAnalyzeBatchResultsRequest extends Omit<
  documents.ListDocumentModelAnalyzeBatchResultsRequest,
  "endpoint"
> {}

/**
 * List batch document analysis results.
 *
 * Binding assigns a custom role
 * (`AzureAIDocumentAnalyzeBatchResultsReadRole`, one per stack) with exactly
 * the data action `FormRecognizer/documentmodels/analyzebatchresults/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListDocumentAnalyzeBatchResultsHttp}.
 *
 * ### Calling ListDocumentAnalyzeBatchResults
 * **Example:** ListDocumentAnalyzeBatchResults from a Function
 * ```typescript
 * // init
 * const listDocumentAnalyzeBatchResults = yield* Azure.CognitiveServices.ListDocumentAnalyzeBatchResults(account);
 *
 * // runtime
 * const result = yield* listDocumentAnalyzeBatchResults({ modelId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListDocumentAnalyzeBatchResults extends Binding.Service<
  ListDocumentAnalyzeBatchResults,
  "Azure.CognitiveServices.ListDocumentAnalyzeBatchResults",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ListDocumentAnalyzeBatchResultsRequest,
    ) => Effect.Effect<
      documents.PagedAnalyzeBatchOperation,
      documents.ListDocumentModelAnalyzeBatchResultsError,
      RuntimeContext
    >
  >
> {}

export const ListDocumentAnalyzeBatchResults = Binding.Service<ListDocumentAnalyzeBatchResults>(
  "Azure.CognitiveServices.ListDocumentAnalyzeBatchResults",
);
