import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteDocumentAnalyzeBatchResultRequest extends Omit<
  documents.DeleteDocumentModelAnalyzeBatchResultRequest,
  "endpoint"
> {}

/**
 * Mark the batch document analysis result for deletion.
 *
 * Binding assigns a custom role (`AzureAIDocumentAnalyzeBatchResultsRole`,
 * one per stack) with exactly the data action
 * `FormRecognizer/documentmodels/analyzebatchresults/*` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteDocumentAnalyzeBatchResultHttp}.
 *
 * ### Calling DeleteDocumentAnalyzeBatchResult
 * **Example:** DeleteDocumentAnalyzeBatchResult from a Function
 * ```typescript
 * // init
 * const deleteDocumentAnalyzeBatchResult = yield* Azure.CognitiveServices.DeleteDocumentAnalyzeBatchResult(account);
 *
 * // runtime
 * const result = yield* deleteDocumentAnalyzeBatchResult({ modelId, resultId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteDocumentAnalyzeBatchResult extends Binding.Service<
  DeleteDocumentAnalyzeBatchResult,
  "Azure.CognitiveServices.DeleteDocumentAnalyzeBatchResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteDocumentAnalyzeBatchResultRequest,
    ) => Effect.Effect<
      documents.DeleteDocumentModelAnalyzeBatchResultResponse,
      documents.DeleteDocumentModelAnalyzeBatchResultError,
      RuntimeContext
    >
  >
> {}

export const DeleteDocumentAnalyzeBatchResult = Binding.Service<DeleteDocumentAnalyzeBatchResult>(
  "Azure.CognitiveServices.DeleteDocumentAnalyzeBatchResult",
);
