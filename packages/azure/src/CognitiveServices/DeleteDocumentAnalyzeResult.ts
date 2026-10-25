import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteDocumentAnalyzeResultRequest extends Omit<
  documents.DeleteDocumentModelAnalyzeResultRequest,
  "endpoint"
> {}

/**
 * Mark the result of document analysis for deletion.
 *
 * Binding assigns a custom role (`AzureAIDocumentAnalyzeResultsRole`, one
 * per stack) with exactly the data action
 * `FormRecognizer/documentmodels/analyzeresults/*` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteDocumentAnalyzeResultHttp}.
 *
 * ### Calling DeleteDocumentAnalyzeResult
 * **Example:** DeleteDocumentAnalyzeResult from a Function
 * ```typescript
 * // init
 * const deleteDocumentAnalyzeResult = yield* Azure.CognitiveServices.DeleteDocumentAnalyzeResult(account);
 *
 * // runtime
 * const result = yield* deleteDocumentAnalyzeResult({ modelId, resultId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteDocumentAnalyzeResult extends Binding.Service<
  DeleteDocumentAnalyzeResult,
  "Azure.CognitiveServices.DeleteDocumentAnalyzeResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteDocumentAnalyzeResultRequest,
    ) => Effect.Effect<
      documents.DeleteDocumentModelAnalyzeResultResponse,
      documents.DeleteDocumentModelAnalyzeResultError,
      RuntimeContext
    >
  >
> {}

export const DeleteDocumentAnalyzeResult = Binding.Service<DeleteDocumentAnalyzeResult>(
  "Azure.CognitiveServices.DeleteDocumentAnalyzeResult",
);
