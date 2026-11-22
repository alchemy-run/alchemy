import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateContentAnalyzerRequest extends Omit<
  cu.UpdateContentAnalyzerRequest,
  "endpoint"
> {}

/**
 * Update analyzer properties.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzersWriteRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/analyzers/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateContentAnalyzerHttp}.
 *
 * ### Calling UpdateContentAnalyzer
 * **Example:** UpdateContentAnalyzer from a Function
 * ```typescript
 * // init
 * const updateContentAnalyzer = yield* Azure.CognitiveServices.UpdateContentAnalyzer(account);
 *
 * // runtime
 * const result = yield* updateContentAnalyzer({ analyzerId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateContentAnalyzer extends Binding.Service<
  UpdateContentAnalyzer,
  "Azure.CognitiveServices.UpdateContentAnalyzer",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdateContentAnalyzerRequest,
    ) => Effect.Effect<cu.ContentAnalyzer, cu.UpdateContentAnalyzerError, RuntimeContext>
  >
> {}

export const UpdateContentAnalyzer = Binding.Service<UpdateContentAnalyzer>(
  "Azure.CognitiveServices.UpdateContentAnalyzer",
);
