import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DeleteAgentRequest extends Omit<agents.DeleteAgentRequest, "endpoint"> {}

/**
 * Deletes an agent.
 *
 * Binding assigns a custom role (`AzureAIAgentsDeleteRole`, one per stack)
 * with exactly the data action `AIServices/agents/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the Foundry project only. The
 * project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteAgentHttp}.
 *
 * ### Calling DeleteAgent
 * **Example:** DeleteAgent from a Function
 * ```typescript
 * // init
 * const deleteAgent = yield* Azure.CognitiveServices.DeleteAgent(project);
 *
 * // runtime
 * const result = yield* deleteAgent({ assistantId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteAgent extends Binding.Service<
  DeleteAgent,
  "Azure.CognitiveServices.DeleteAgent",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DeleteAgentRequest,
    ) => Effect.Effect<agents.AgentDeletionStatus, agents.DeleteAgentError, RuntimeContext>
  >
> {}

export const DeleteAgent = Binding.Service<DeleteAgent>("Azure.CognitiveServices.DeleteAgent");
