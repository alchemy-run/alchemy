import type * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface LookupDictionaryRequest extends Omit<
  tt.LookupTranslatorDictionaryRequest,
  "endpoint"
> {}

/**
 * Look up alternative translations of a word or short phrase (with part of speech and back-translations) with Azure AI Translator.
 *
 * Bind it to an Azure AI services account of kind `TextTranslation` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveLookupDictionaryRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/TextTranslation/dictionary/lookup/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link LookupDictionaryHttp}.
 *
 * ### Calling LookupDictionary
 * **Example:** LookupDictionary from a Function
 * ```typescript
 * // init
 * const lookupDictionary = yield* Azure.CognitiveServices.LookupDictionary(translator);
 *
 * // runtime
 * const [entry] = yield* lookupDictionary({ from: "en", to: "es", body: [{ text: "fly" }] });
 * // entry.translations.map((t) => t.displayTarget)
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface LookupDictionary extends Binding.Service<
  LookupDictionary,
  "Azure.CognitiveServices.LookupDictionary",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: LookupDictionaryRequest,
    ) => Effect.Effect<
      tt.LookupTranslatorDictionaryResponse,
      tt.LookupTranslatorDictionaryError,
      RuntimeContext
    >
  >
> {}

export const LookupDictionary = Binding.Service<LookupDictionary>(
  "Azure.CognitiveServices.LookupDictionary",
);
