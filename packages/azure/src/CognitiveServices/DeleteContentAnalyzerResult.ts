import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteContentAnalyzerResultRequest extends Omit<
  cu.DeleteContentAnalyzerResultRequest,
  "endpoint"
> {}

/**
 * Mark the result of an analysis operation for deletion.
 *
 * Binding assigns a custom role (`AzureAIContentResultsDeleteRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/analyzerresults/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteContentAnalyzerResultHttp}.
 *
 * ### Calling DeleteContentAnalyzerResult
 * **Example:** DeleteContentAnalyzerResult from a Function
 * ```typescript
 * // init
 * const deleteContentAnalyzerResult = yield* Azure.CognitiveServices.DeleteContentAnalyzerResult(account);
 *
 * // runtime
 * const result = yield* deleteContentAnalyzerResult({ operationId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteContentAnalyzerResult extends Binding.Service<
  DeleteContentAnalyzerResult,
  "Azure.CognitiveServices.DeleteContentAnalyzerResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteContentAnalyzerResultRequest,
    ) => Effect.Effect<
      cu.DeleteContentAnalyzerResultResponse,
      cu.DeleteContentAnalyzerResultError,
      RuntimeContext
    >
  >
> {}

export const DeleteContentAnalyzerResult = Binding.Service<DeleteContentAnalyzerResult>(
  "Azure.CognitiveServices.DeleteContentAnalyzerResult",
);
