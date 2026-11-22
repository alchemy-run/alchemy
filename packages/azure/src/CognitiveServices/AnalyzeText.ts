import type * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeTextRequest extends Omit<lang.AnalyzeTextRequest, "endpoint"> {}

/**
 * Run one Azure AI Language analysis (sentiment, entities, PII, key
 * phrases, language detection, or entity linking) over up to a few
 * documents and get the results in the response. `results` holds the
 * `kind`-specific `{ documents, errors, modelVersion }`.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageAnalyzeTextRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-text/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AnalyzeTextHttp}.
 *
 * ### Calling AnalyzeText
 * **Example:** AnalyzeText from a Function
 * ```typescript
 * // init
 * const analyzeText = yield* Azure.CognitiveServices.AnalyzeText(language);
 *
 * // runtime
 * const sentiment = yield* analyzeText({
 *   kind: "SentimentAnalysis",
 *   analysisInput: { documents: [{ id: "1", text: "I love this", language: "en" }] },
 * });
 * // sentiment.results → { documents: [{ id: "1", sentiment: "positive", … }], … }
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeText extends Binding.Service<
  AnalyzeText,
  "Azure.CognitiveServices.AnalyzeText",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeTextRequest,
    ) => Effect.Effect<lang.AnalyzeTextTaskResult, lang.AnalyzeTextError, RuntimeContext>
  >
> {}

export const AnalyzeText = Binding.Service<AnalyzeText>("Azure.CognitiveServices.AnalyzeText");
