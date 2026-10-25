import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteContentAnalyzerRequest extends Omit<
  cu.DeleteContentAnalyzerRequest,
  "endpoint"
> {}

/**
 * Delete analyzer.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzersDeleteRole`, one
 * per stack) with exactly the data action
 * `MultiModalIntelligence/analyzers/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteContentAnalyzerHttp}.
 *
 * ### Calling DeleteContentAnalyzer
 * **Example:** DeleteContentAnalyzer from a Function
 * ```typescript
 * // init
 * const deleteContentAnalyzer = yield* Azure.CognitiveServices.DeleteContentAnalyzer(account);
 *
 * // runtime
 * const result = yield* deleteContentAnalyzer({ analyzerId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteContentAnalyzer extends Binding.Service<
  DeleteContentAnalyzer,
  "Azure.CognitiveServices.DeleteContentAnalyzer",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteContentAnalyzerRequest,
    ) => Effect.Effect<
      cu.DeleteContentAnalyzerResponse,
      cu.DeleteContentAnalyzerError,
      RuntimeContext
    >
  >
> {}

export const DeleteContentAnalyzer = Binding.Service<DeleteContentAnalyzer>(
  "Azure.CognitiveServices.DeleteContentAnalyzer",
);
