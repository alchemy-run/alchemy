import type * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface TranslateTextRequest extends Omit<tt.TranslatorTranslateRequest, "endpoint"> {}

/**
 * Translate text into one or more languages with Azure AI Translator (Text v3.0).
 *
 * Bind it to an Azure AI services account of kind `TextTranslation` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveTranslateTextRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/TextTranslation/translate/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link TranslateTextHttp}.
 *
 * ### Calling TranslateText
 * **Example:** TranslateText from a Function
 * ```typescript
 * // init
 * const translateText = yield* Azure.CognitiveServices.TranslateText(translator);
 *
 * // runtime
 * const [result] = yield* translateText({ to: ["de", "fr"], body: [{ text: "Hello" }] });
 * // result.translations[0].text === "Hallo"
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface TranslateText extends Binding.Service<
  TranslateText,
  "Azure.CognitiveServices.TranslateText",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: TranslateTextRequest,
    ) => Effect.Effect<tt.TranslatorTranslateResponse, tt.TranslatorTranslateError, RuntimeContext>
  >
> {}

export const TranslateText = Binding.Service<TranslateText>(
  "Azure.CognitiveServices.TranslateText",
);
