import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CopyContentAnalyzerRequest extends Omit<
  cu.CopyContentAnalyzerRequest,
  "endpoint"
> {}

/**
 * Create a copy of the source analyzer to the current location.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzerCopyRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/analyzers:copy/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CopyContentAnalyzerHttp}.
 *
 * ### Calling CopyContentAnalyzer
 * **Example:** CopyContentAnalyzer from a Function
 * ```typescript
 * // init
 * const copyContentAnalyzer = yield* Azure.CognitiveServices.CopyContentAnalyzer(account);
 *
 * // runtime
 * const result = yield* copyContentAnalyzer({ analyzerId, sourceAnalyzerId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CopyContentAnalyzer extends Binding.Service<
  CopyContentAnalyzer,
  "Azure.CognitiveServices.CopyContentAnalyzer",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CopyContentAnalyzerRequest,
    ) => Effect.Effect<cu.CopyContentAnalyzerResponse, cu.CopyContentAnalyzerError, RuntimeContext>
  >
> {}

export const CopyContentAnalyzer = Binding.Service<CopyContentAnalyzer>(
  "Azure.CognitiveServices.CopyContentAnalyzer",
);
