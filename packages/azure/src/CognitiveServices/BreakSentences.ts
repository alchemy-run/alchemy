import type * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface BreakSentencesRequest extends Omit<
  tt.TranslatorBreakSentenceRequest,
  "endpoint"
> {}

/**
 * Find the sentence boundaries in a text with Azure AI Translator.
 *
 * Bind it to an Azure AI services account of kind `TextTranslation` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveBreakSentencesRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/TextTranslation/breaksentence/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link BreakSentencesHttp}.
 *
 * ### Calling BreakSentences
 * **Example:** BreakSentences from a Function
 * ```typescript
 * // init
 * const breakSentences = yield* Azure.CognitiveServices.BreakSentences(translator);
 *
 * // runtime
 * const [result] = yield* breakSentences({ Language: "en", body: [{ text: "One. Two." }] });
 * // result.sentLen === [5, 4]
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface BreakSentences extends Binding.Service<
  BreakSentences,
  "Azure.CognitiveServices.BreakSentences",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: BreakSentencesRequest,
    ) => Effect.Effect<
      tt.TranslatorBreakSentenceResponse,
      tt.TranslatorBreakSentenceError,
      RuntimeContext
    >
  >
> {}

export const BreakSentences = Binding.Service<BreakSentences>(
  "Azure.CognitiveServices.BreakSentences",
);
