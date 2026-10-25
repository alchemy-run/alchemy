import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetContentAnalyzerOperationStatusRequest extends Omit<
  cu.GetContentAnalyzerOperationStatusRequest,
  "endpoint"
> {}

/**
 * Get the status of an analyzer creation operation.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzerOperationsReadRole`,
 * one per stack) with exactly the data action
 * `MultiModalIntelligence/analyzers/operations/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetContentAnalyzerOperationStatusHttp}.
 *
 * ### Calling GetContentAnalyzerOperationStatus
 * **Example:** GetContentAnalyzerOperationStatus from a Function
 * ```typescript
 * // init
 * const getContentAnalyzerOperationStatus = yield* Azure.CognitiveServices.GetContentAnalyzerOperationStatus(account);
 *
 * // runtime
 * const result = yield* getContentAnalyzerOperationStatus({ analyzerId, operationId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetContentAnalyzerOperationStatus extends Binding.Service<
  GetContentAnalyzerOperationStatus,
  "Azure.CognitiveServices.GetContentAnalyzerOperationStatus",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetContentAnalyzerOperationStatusRequest,
    ) => Effect.Effect<
      cu.ContentAnalyzerOperationStatus,
      cu.GetContentAnalyzerOperationStatusError,
      RuntimeContext
    >
  >
> {}

export const GetContentAnalyzerOperationStatus = Binding.Service<GetContentAnalyzerOperationStatus>(
  "Azure.CognitiveServices.GetContentAnalyzerOperationStatus",
);
