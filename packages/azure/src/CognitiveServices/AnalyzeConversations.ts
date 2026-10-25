import type * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeConversationsRequest extends Omit<
  conversations.AnalyzeConversationsRequest,
  "endpoint"
> {}

/**
 * Predict the intents and entities of one conversation item with a
 * deployed conversational language understanding (CLU) or orchestration
 * project. `result` holds `{ query, prediction }`.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageAnalyzeConversationsRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-conversations/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AnalyzeConversationsHttp}.
 *
 * ### Calling AnalyzeConversations
 * **Example:** AnalyzeConversations from a Function
 * ```typescript
 * // init
 * const analyzeConversations = yield* Azure.CognitiveServices.AnalyzeConversations(language);
 *
 * // runtime
 * const { result } = yield* analyzeConversations({
 *   kind: "Conversation",
 *   analysisInput: { conversationItem: { id: "1", participantId: "user", text: "Book a flight" } },
 *   parameters: { projectName: "travel", deploymentName: "production" },
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeConversations extends Binding.Service<
  AnalyzeConversations,
  "Azure.CognitiveServices.AnalyzeConversations",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeConversationsRequest,
    ) => Effect.Effect<
      conversations.AnalyzeConversationTaskResult,
      conversations.AnalyzeConversationsError,
      RuntimeContext
    >
  >
> {}

export const AnalyzeConversations = Binding.Service<AnalyzeConversations>(
  "Azure.CognitiveServices.AnalyzeConversations",
);
