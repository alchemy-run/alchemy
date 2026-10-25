import type * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CancelAnalyzeConversationsJobRequest extends Omit<
  conversations.AnalyzeConversationsCancelJobRequest,
  "endpoint"
> {}

/**
 * Cancel a running Azure AI Language conversation analysis job.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageCancelAnalyzeConversationsJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-conversations/jobscancel/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelAnalyzeConversationsJobHttp}.
 *
 * ### Calling CancelAnalyzeConversationsJob
 * **Example:** CancelAnalyzeConversationsJob from a Function
 * ```typescript
 * // init
 * const cancelJob = yield* Azure.CognitiveServices.CancelAnalyzeConversationsJob(language);
 *
 * // runtime
 * yield* cancelJob({ jobId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CancelAnalyzeConversationsJob extends Binding.Service<
  CancelAnalyzeConversationsJob,
  "Azure.CognitiveServices.CancelAnalyzeConversationsJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CancelAnalyzeConversationsJobRequest,
    ) => Effect.Effect<
      conversations.AnalyzeConversationsCancelJobResponse,
      conversations.AnalyzeConversationsCancelJobError,
      RuntimeContext
    >
  >
> {}

export const CancelAnalyzeConversationsJob = Binding.Service<CancelAnalyzeConversationsJob>(
  "Azure.CognitiveServices.CancelAnalyzeConversationsJob",
);
