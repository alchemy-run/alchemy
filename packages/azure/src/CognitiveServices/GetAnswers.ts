import type * as qna from "@distilled.cloud/azure/cognitiveservices-language-question-answering";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetAnswersRequest extends Omit<
  qna.GetQuestionAnsweringAnswersRequest,
  "endpoint"
> {}

/**
 * Answer a question from a deployed custom question answering project
 * (knowledge base) on the Language account.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageQueryKnowledgeBasesRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/query-knowledgebases/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetAnswersHttp}.
 *
 * ### Calling GetAnswers
 * **Example:** GetAnswers from a Function
 * ```typescript
 * // init
 * const getAnswers = yield* Azure.CognitiveServices.GetAnswers(language);
 *
 * // runtime
 * const { answers } = yield* getAnswers({
 *   projectName: "faq",
 *   deploymentName: "production",
 *   question: "How do I reset my password?",
 *   top: 3,
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAnswers extends Binding.Service<
  GetAnswers,
  "Azure.CognitiveServices.GetAnswers",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetAnswersRequest,
    ) => Effect.Effect<qna.AnswersResult, qna.GetQuestionAnsweringAnswersError, RuntimeContext>
  >
> {}

export const GetAnswers = Binding.Service<GetAnswers>("Azure.CognitiveServices.GetAnswers");
