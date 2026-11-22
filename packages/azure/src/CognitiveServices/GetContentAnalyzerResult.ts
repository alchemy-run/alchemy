import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetContentAnalyzerResultRequest extends Omit<
  cu.GetContentAnalyzerResultRequest,
  "endpoint"
> {}

/**
 * Get the result of an analysis operation.
 *
 * Binding assigns a custom role (`AzureAIContentResultsReadRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/analyzerresults/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetContentAnalyzerResultHttp}.
 *
 * ### Calling GetContentAnalyzerResult
 * **Example:** GetContentAnalyzerResult from a Function
 * ```typescript
 * // init
 * const getContentAnalyzerResult = yield* Azure.CognitiveServices.GetContentAnalyzerResult(account);
 *
 * // runtime
 * const result = yield* getContentAnalyzerResult({ operationId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetContentAnalyzerResult extends Binding.Service<
  GetContentAnalyzerResult,
  "Azure.CognitiveServices.GetContentAnalyzerResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetContentAnalyzerResultRequest,
    ) => Effect.Effect<
      cu.ContentAnalyzerAnalyzeOperationStatus,
      cu.GetContentAnalyzerResultError,
      RuntimeContext
    >
  >
> {}

export const GetContentAnalyzerResult = Binding.Service<GetContentAnalyzerResult>(
  "Azure.CognitiveServices.GetContentAnalyzerResult",
);
