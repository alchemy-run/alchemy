import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateAgentMessageRequest extends Omit<
  agents.CreateMessageMessageRequest,
  "endpoint"
> {}

/**
 * Creates a new message on a specified thread.
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
 * {@link CreateAgentMessageHttp}.
 *
 * ### Calling CreateAgentMessage
 * **Example:** CreateAgentMessage from a Function
 * ```typescript
 * // init
 * const createAgentMessage = yield* Azure.CognitiveServices.CreateAgentMessage(project);
 *
 * // runtime
 * const message = yield* createAgentMessage({ threadId, role: "user", content: "Hello" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateAgentMessage extends Binding.Service<
  CreateAgentMessage,
  "Azure.CognitiveServices.CreateAgentMessage",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateAgentMessageRequest,
    ) => Effect.Effect<agents.ThreadMessage, agents.CreateMessageMessageError, RuntimeContext>
  >
> {}

export const CreateAgentMessage = Binding.Service<CreateAgentMessage>(
  "Azure.CognitiveServices.CreateAgentMessage",
);
