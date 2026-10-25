import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListAgentMessagesRequest extends Omit<
  agents.ListMessageMessagesRequest,
  "endpoint"
> {}

/**
 * Gets a list of messages that exist on a thread.
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
 * {@link ListAgentMessagesHttp}.
 *
 * ### Calling ListAgentMessages
 * **Example:** ListAgentMessages from a Function
 * ```typescript
 * // init
 * const listAgentMessages = yield* Azure.CognitiveServices.ListAgentMessages(project);
 *
 * // runtime
 * const { data } = yield* listAgentMessages({ threadId, order: "asc" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListAgentMessages extends Binding.Service<
  ListAgentMessages,
  "Azure.CognitiveServices.ListAgentMessages",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListAgentMessagesRequest,
    ) => Effect.Effect<
      agents.ListMessageMessagesResponse,
      agents.ListMessageMessagesError,
      RuntimeContext
    >
  >
> {}

export const ListAgentMessages = Binding.Service<ListAgentMessages>(
  "Azure.CognitiveServices.ListAgentMessages",
);
