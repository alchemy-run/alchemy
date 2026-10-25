import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface UpdateAgentThreadRequest extends Omit<
  agents.UpdateThreadThreadRequest,
  "endpoint"
> {}

/**
 * Modifies an existing thread.
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
 * {@link UpdateAgentThreadHttp}.
 *
 * ### Calling UpdateAgentThread
 * **Example:** UpdateAgentThread from a Function
 * ```typescript
 * // init
 * const updateAgentThread = yield* Azure.CognitiveServices.UpdateAgentThread(project);
 *
 * // runtime
 * const result = yield* updateAgentThread({ threadId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateAgentThread extends Binding.Service<
  UpdateAgentThread,
  "Azure.CognitiveServices.UpdateAgentThread",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: UpdateAgentThreadRequest,
    ) => Effect.Effect<agents.AgentThread, agents.UpdateThreadThreadError, RuntimeContext>
  >
> {}

export const UpdateAgentThread = Binding.Service<UpdateAgentThread>(
  "Azure.CognitiveServices.UpdateAgentThread",
);
