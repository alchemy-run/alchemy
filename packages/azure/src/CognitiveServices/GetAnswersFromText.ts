import type * as qna from "@distilled.cloud/azure/cognitiveservices-language-question-answering";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetAnswersFromTextRequest extends Omit<
  qna.GetQuestionAnsweringAnswersFromTextRequest,
  "endpoint"
> {}

/**
 * Answer a question from text records passed in the request (prebuilt
 * question answering, no project needed).
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageQueryTextRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/query-text/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetAnswersFromTextHttp}.
 *
 * ### Calling GetAnswersFromText
 * **Example:** GetAnswersFromText from a Function
 * ```typescript
 * // init
 * const getAnswersFromText = yield* Azure.CognitiveServices.GetAnswersFromText(language);
 *
 * // runtime
 * const { answers } = yield* getAnswersFromText({
 *   question: "How long does the battery last?",
 *   records: [{ id: "1", text: "The battery lasts up to 10 hours on a charge." }],
 *   language: "en",
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAnswersFromText extends Binding.Service<
  GetAnswersFromText,
  "Azure.CognitiveServices.GetAnswersFromText",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetAnswersFromTextRequest,
    ) => Effect.Effect<
      qna.AnswersFromTextResult,
      qna.GetQuestionAnsweringAnswersFromTextError,
      RuntimeContext
    >
  >
> {}

export const GetAnswersFromText = Binding.Service<GetAnswersFromText>(
  "Azure.CognitiveServices.GetAnswersFromText",
);
