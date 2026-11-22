import type * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListTranslatorLanguagesRequest extends Omit<
  tt.TranslatorLanguagesRequest,
  "endpoint"
> {}

/**
 * List the languages Azure AI Translator supports for translation, transliteration, and dictionary lookups, keyed by language code.
 *
 * Bind it to an Azure AI services account of kind `TextTranslation` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveListTranslatorLanguagesRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/TextTranslation/languages/read`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListTranslatorLanguagesHttp}.
 *
 * ### Calling ListTranslatorLanguages
 * **Example:** ListTranslatorLanguages from a Function
 * ```typescript
 * // init
 * const listTranslatorLanguages = yield* Azure.CognitiveServices.ListTranslatorLanguages(translator);
 *
 * // runtime
 * const { translation } = yield* listTranslatorLanguages({ scope: ["translation"] });
 * // translation?.de?.name === "German"
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListTranslatorLanguages extends Binding.Service<
  ListTranslatorLanguages,
  "Azure.CognitiveServices.ListTranslatorLanguages",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ListTranslatorLanguagesRequest,
    ) => Effect.Effect<tt.LanguagesResult, tt.TranslatorLanguagesError, RuntimeContext>
  >
> {}

export const ListTranslatorLanguages = Binding.Service<ListTranslatorLanguages>(
  "Azure.CognitiveServices.ListTranslatorLanguages",
);
