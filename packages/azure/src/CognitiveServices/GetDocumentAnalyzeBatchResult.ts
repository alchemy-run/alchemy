import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentAnalyzeBatchResultRequest extends Omit<
  documents.GetDocumentModelAnalyzeBatchResultRequest,
  "endpoint"
> {}

/**
 * Gets the result of batch document analysis.
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
 * {@link GetDocumentAnalyzeBatchResultHttp}.
 *
 * ### Calling GetDocumentAnalyzeBatchResult
 * **Example:** GetDocumentAnalyzeBatchResult from a Function
 * ```typescript
 * // init
 * const getDocumentAnalyzeBatchResult = yield* Azure.CognitiveServices.GetDocumentAnalyzeBatchResult(account);
 *
 * // runtime
 * const result = yield* getDocumentAnalyzeBatchResult({ modelId, resultId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentAnalyzeBatchResult extends Binding.Service<
  GetDocumentAnalyzeBatchResult,
  "Azure.CognitiveServices.GetDocumentAnalyzeBatchResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentAnalyzeBatchResultRequest,
    ) => Effect.Effect<
      documents.AnalyzeBatchOperation,
      documents.GetDocumentModelAnalyzeBatchResultError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentAnalyzeBatchResult = Binding.Service<GetDocumentAnalyzeBatchResult>(
  "Azure.CognitiveServices.GetDocumentAnalyzeBatchResult",
);
