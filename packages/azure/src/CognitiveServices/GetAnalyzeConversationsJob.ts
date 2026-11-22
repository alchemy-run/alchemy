import type * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetAnalyzeConversationsJobRequest extends Omit<
  conversations.AnalyzeConversationsJobStatusRequest,
  "endpoint"
> {}

/**
 * Read the status of an Azure AI Language conversation analysis job, and
 * each task's `results` once it has `succeeded`.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageReadAnalyzeConversationsJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-conversations/jobs/read`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetAnalyzeConversationsJobHttp}.
 *
 * ### Calling GetAnalyzeConversationsJob
 * **Example:** GetAnalyzeConversationsJob from a Function
 * ```typescript
 * // init
 * const getJob = yield* Azure.CognitiveServices.GetAnalyzeConversationsJob(language);
 *
 * // runtime
 * const job = yield* getJob({ jobId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAnalyzeConversationsJob extends Binding.Service<
  GetAnalyzeConversationsJob,
  "Azure.CognitiveServices.GetAnalyzeConversationsJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetAnalyzeConversationsJobRequest,
    ) => Effect.Effect<
      conversations.AnalyzeConversationJobState,
      conversations.AnalyzeConversationsJobStatusError,
      RuntimeContext
    >
  >
> {}

export const GetAnalyzeConversationsJob = Binding.Service<GetAnalyzeConversationsJob>(
  "Azure.CognitiveServices.GetAnalyzeConversationsJob",
);
