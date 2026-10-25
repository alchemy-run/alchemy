import type * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface TransliterateTextRequest extends Omit<
  tt.TranslatorTransliterateRequest,
  "endpoint"
> {}

/**
 * Convert text from one script to another (e.g. Japanese to Latin script) with Azure AI Translator.
 *
 * Bind it to an Azure AI services account of kind `TextTranslation` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveTransliterateTextRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/TextTranslation/transliterate/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link TransliterateTextHttp}.
 *
 * ### Calling TransliterateText
 * **Example:** TransliterateText from a Function
 * ```typescript
 * // init
 * const transliterateText = yield* Azure.CognitiveServices.TransliterateText(translator);
 *
 * // runtime
 * const [latin] = yield* transliterateText({
 *   language: "ja",
 *   fromScript: "Jpan",
 *   toScript: "Latn",
 *   body: [{ text: "こんにちは" }],
 * });
 * // latin.text === "konnichiwa"
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface TransliterateText extends Binding.Service<
  TransliterateText,
  "Azure.CognitiveServices.TransliterateText",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: TransliterateTextRequest,
    ) => Effect.Effect<
      tt.TranslatorTransliterateResponse,
      tt.TranslatorTransliterateError,
      RuntimeContext
    >
  >
> {}

export const TransliterateText = Binding.Service<TransliterateText>(
  "Azure.CognitiveServices.TransliterateText",
);
