import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface UpdateAgentMessageRequest extends Omit<
  agents.UpdateMessageMessageRequest,
  "endpoint"
> {}

/**
 * Modifies an existing message on an existing thread.
 *
 * Binding assigns a custom role (`AzureAIAgentsWriteRole`, one per stack)
 * with exactly the data action `AIServices/agents/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the Foundry project only. The
 * project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateAgentMessageHttp}.
 *
 * ### Calling UpdateAgentMessage
 * **Example:** UpdateAgentMessage from a Function
 * ```typescript
 * // init
 * const updateAgentMessage = yield* Azure.CognitiveServices.UpdateAgentMessage(project);
 *
 * // runtime
 * const result = yield* updateAgentMessage({ threadId, messageId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateAgentMessage extends Binding.Service<
  UpdateAgentMessage,
  "Azure.CognitiveServices.UpdateAgentMessage",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: UpdateAgentMessageRequest,
    ) => Effect.Effect<agents.ThreadMessage, agents.UpdateMessageMessageError, RuntimeContext>
  >
> {}

export const UpdateAgentMessage = Binding.Service<UpdateAgentMessage>(
  "Azure.CognitiveServices.UpdateAgentMessage",
);
