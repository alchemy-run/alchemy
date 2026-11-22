import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeTextSafetyRequest extends Omit<
  contentSafety.TextOperationsAnalyzeTextRequest,
  "endpoint"
> {}

/**
 * Score text for harmful content (hate, self-harm, sexual, violence) with
 * Azure AI Content Safety, optionally matching it against text
 * blocklists.
 *
 * Bind it to an Azure AI services account of kind `ContentSafety` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesContentSafetyAnalyzeTextRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ContentSafety/text:analyze/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AnalyzeTextSafetyHttp}.
 *
 * ### Calling AnalyzeTextSafety
 * **Example:** AnalyzeTextSafety from a Function
 * ```typescript
 * // init
 * const analyzeTextSafety = yield* Azure.CognitiveServices.AnalyzeTextSafety(safety);
 *
 * // runtime
 * const { categoriesAnalysis } = yield* analyzeTextSafety({ text: userMessage });
 * const flagged = categoriesAnalysis.some((c) => (c.severity ?? 0) >= 4);
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeTextSafety extends Binding.Service<
  AnalyzeTextSafety,
  "Azure.CognitiveServices.AnalyzeTextSafety",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeTextSafetyRequest,
    ) => Effect.Effect<
      contentSafety.AnalyzeTextResult,
      contentSafety.TextOperationsAnalyzeTextError,
      RuntimeContext
    >
  >
> {}

export const AnalyzeTextSafety = Binding.Service<AnalyzeTextSafety>(
  "Azure.CognitiveServices.AnalyzeTextSafety",
);
