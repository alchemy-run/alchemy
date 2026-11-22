import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetContentAnalyzerRequest extends Omit<cu.GetContentAnalyzerRequest, "endpoint"> {}

/**
 * Get analyzer properties.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzersReadRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/analyzers/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetContentAnalyzerHttp}.
 *
 * ### Calling GetContentAnalyzer
 * **Example:** GetContentAnalyzer from a Function
 * ```typescript
 * // init
 * const getContentAnalyzer = yield* Azure.CognitiveServices.GetContentAnalyzer(account);
 *
 * // runtime
 * const result = yield* getContentAnalyzer({ analyzerId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetContentAnalyzer extends Binding.Service<
  GetContentAnalyzer,
  "Azure.CognitiveServices.GetContentAnalyzer",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetContentAnalyzerRequest,
    ) => Effect.Effect<cu.ContentAnalyzer, cu.GetContentAnalyzerError, RuntimeContext>
  >
> {}

export const GetContentAnalyzer = Binding.Service<GetContentAnalyzer>(
  "Azure.CognitiveServices.GetContentAnalyzer",
);
