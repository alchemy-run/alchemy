import type * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface SubmitAnalyzeConversationsJobRequest extends Omit<
  conversations.AnalyzeConversationsSubmitJobRequest,
  "endpoint"
> {}

/**
 * Submit an Azure AI Language long-running conversation analysis job
 * (conversation PII redaction or summarization). The response's
 * `operationLocation` ends in the job ID; read the job with
 * {@link GetAnalyzeConversationsJob}.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageSubmitAnalyzeConversationsJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-conversations/jobs/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SubmitAnalyzeConversationsJobHttp}.
 *
 * ### Calling SubmitAnalyzeConversationsJob
 * **Example:** SubmitAnalyzeConversationsJob from a Function
 * ```typescript
 * // init
 * const submitJob = yield* Azure.CognitiveServices.SubmitAnalyzeConversationsJob(language);
 *
 * // runtime
 * const { operationLocation } = yield* submitJob({
 *   analysisInput: {
 *     conversations: [{
 *       id: "1",
 *       language: "en",
 *       modality: "text",
 *       conversationItems: [{ id: "1", participantId: "agent", text: "Call me at 555-0100" }],
 *     }],
 *   },
 *   tasks: [{ kind: "ConversationalPIITask" }],
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface SubmitAnalyzeConversationsJob extends Binding.Service<
  SubmitAnalyzeConversationsJob,
  "Azure.CognitiveServices.SubmitAnalyzeConversationsJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: SubmitAnalyzeConversationsJobRequest,
    ) => Effect.Effect<
      conversations.AnalyzeConversationsSubmitJobResponse,
      conversations.AnalyzeConversationsSubmitJobError,
      RuntimeContext
    >
  >
> {}

export const SubmitAnalyzeConversationsJob = Binding.Service<SubmitAnalyzeConversationsJob>(
  "Azure.CognitiveServices.SubmitAnalyzeConversationsJob",
);
