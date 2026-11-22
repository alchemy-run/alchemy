import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetAgentMessageRequest extends Omit<agents.GetMessageMessageRequest, "endpoint"> {}

/**
 * Retrieves an existing message.
 *
 * Binding assigns a custom role (`AzureAIAgentsReadRole`, one per stack)
 * with exactly the data action `AIServices/agents/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the Foundry project only. The
 * project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetAgentMessageHttp}.
 *
 * ### Calling GetAgentMessage
 * **Example:** GetAgentMessage from a Function
 * ```typescript
 * // init
 * const getAgentMessage = yield* Azure.CognitiveServices.GetAgentMessage(project);
 *
 * // runtime
 * const result = yield* getAgentMessage({ threadId, messageId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAgentMessage extends Binding.Service<
  GetAgentMessage,
  "Azure.CognitiveServices.GetAgentMessage",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetAgentMessageRequest,
    ) => Effect.Effect<agents.ThreadMessage, agents.GetMessageMessageError, RuntimeContext>
  >
> {}

export const GetAgentMessage = Binding.Service<GetAgentMessage>(
  "Azure.CognitiveServices.GetAgentMessage",
);
