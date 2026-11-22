import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateAgentThreadRequest extends Omit<
  agents.CreateThreadThreadRequest,
  "endpoint"
> {}

/**
 * Creates a new thread. Threads contain messages and can be run by agents.
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
 * {@link CreateAgentThreadHttp}.
 *
 * ### Calling CreateAgentThread
 * **Example:** CreateAgentThread from a Function
 * ```typescript
 * // init
 * const createAgentThread = yield* Azure.CognitiveServices.CreateAgentThread(project);
 *
 * // runtime
 * const thread = yield* createAgentThread();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateAgentThread extends Binding.Service<
  CreateAgentThread,
  "Azure.CognitiveServices.CreateAgentThread",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: CreateAgentThreadRequest,
    ) => Effect.Effect<agents.AgentThread, agents.CreateThreadThreadError, RuntimeContext>
  >
> {}

export const CreateAgentThread = Binding.Service<CreateAgentThread>(
  "Azure.CognitiveServices.CreateAgentThread",
);
