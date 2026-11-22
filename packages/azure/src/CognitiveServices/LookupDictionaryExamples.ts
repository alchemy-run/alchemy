import type * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface LookupDictionaryExamplesRequest extends Omit<
  tt.TranslatorDictionaryExamplesRequest,
  "endpoint"
> {}

/**
 * Get example sentences for a translation pair returned by `LookupDictionary`, with Azure AI Translator.
 *
 * Bind it to an Azure AI services account of kind `TextTranslation` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveLookupDictionaryExamplesRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/TextTranslation/dictionary/examples/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link LookupDictionaryExamplesHttp}.
 *
 * ### Calling LookupDictionaryExamples
 * **Example:** LookupDictionaryExamples from a Function
 * ```typescript
 * // init
 * const lookupDictionaryExamples = yield* Azure.CognitiveServices.LookupDictionaryExamples(translator);
 *
 * // runtime
 * const [result] = yield* lookupDictionaryExamples({
 *   from: "en",
 *   to: "es",
 *   body: [{ text: "fly", translation: "volar" }],
 * });
 * // result.examples[0].targetTerm === "volar"
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface LookupDictionaryExamples extends Binding.Service<
  LookupDictionaryExamples,
  "Azure.CognitiveServices.LookupDictionaryExamples",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: LookupDictionaryExamplesRequest,
    ) => Effect.Effect<
      tt.TranslatorDictionaryExamplesResponse,
      tt.TranslatorDictionaryExamplesError,
      RuntimeContext
    >
  >
> {}

export const LookupDictionaryExamples = Binding.Service<LookupDictionaryExamples>(
  "Azure.CognitiveServices.LookupDictionaryExamples",
);
