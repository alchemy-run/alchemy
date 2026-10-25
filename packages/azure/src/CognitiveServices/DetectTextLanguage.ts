import type * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DetectTextLanguageRequest extends Omit<tt.TranslatorDetectRequest, "endpoint"> {}

/**
 * Detect the language of each text with Azure AI Translator.
 *
 * Bind it to an Azure AI services account of kind `TextTranslation` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveDetectTextLanguageRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/TextTranslation/detect/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DetectTextLanguageHttp}.
 *
 * ### Calling DetectTextLanguage
 * **Example:** DetectTextLanguage from a Function
 * ```typescript
 * // init
 * const detectTextLanguage = yield* Azure.CognitiveServices.DetectTextLanguage(translator);
 *
 * // runtime
 * const [detected] = yield* detectTextLanguage({ body: [{ text: "Bonjour tout le monde" }] });
 * // detected.language === "fr"
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DetectTextLanguage extends Binding.Service<
  DetectTextLanguage,
  "Azure.CognitiveServices.DetectTextLanguage",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DetectTextLanguageRequest,
    ) => Effect.Effect<tt.TranslatorDetectResponse, tt.TranslatorDetectError, RuntimeContext>
  >
> {}

export const DetectTextLanguage = Binding.Service<DetectTextLanguage>(
  "Azure.CognitiveServices.DetectTextLanguage",
);
