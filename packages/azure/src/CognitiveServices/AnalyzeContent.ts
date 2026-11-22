import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeContentRequest extends Omit<
  cu.ContentAnalyzersAnalyzeRequest,
  "endpoint"
> {}

/**
 * Extract content and fields from input.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzeRole`, one per stack)
 * with exactly the data action
 * `MultiModalIntelligence/analyzers:analyze/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AnalyzeContentHttp}.
 *
 * ### Calling AnalyzeContent
 * **Example:** AnalyzeContent from a Function
 * ```typescript
 * // init
 * const analyzeContent = yield* Azure.CognitiveServices.AnalyzeContent(account);
 *
 * // runtime
 * const { operationLocation } = yield* analyzeContent({
 *   analyzerId: "prebuilt-documentSearch",
 *   inputs: [{ url: "https://example.com/invoice.pdf" }],
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeContent extends Binding.Service<
  AnalyzeContent,
  "Azure.CognitiveServices.AnalyzeContent",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeContentRequest,
    ) => Effect.Effect<
      cu.ContentAnalyzersAnalyzeResponse,
      cu.ContentAnalyzersAnalyzeError,
      RuntimeContext
    >
  >
> {}

export const AnalyzeContent = Binding.Service<AnalyzeContent>(
  "Azure.CognitiveServices.AnalyzeContent",
);
