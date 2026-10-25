import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateAgentRunRequest extends Omit<agents.CreateRunRunRequest, "endpoint"> {}

/**
 * Creates a new run for an agent thread.
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
 * {@link CreateAgentRunHttp}.
 *
 * ### Calling CreateAgentRun
 * **Example:** CreateAgentRun from a Function
 * ```typescript
 * // init
 * const createAgentRun = yield* Azure.CognitiveServices.CreateAgentRun(project);
 *
 * // runtime
 * const run = yield* createAgentRun({ threadId, assistant_id: agentId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateAgentRun extends Binding.Service<
  CreateAgentRun,
  "Azure.CognitiveServices.CreateAgentRun",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateAgentRunRequest,
    ) => Effect.Effect<agents.ThreadRun, agents.CreateRunRunError, RuntimeContext>
  >
> {}

export const CreateAgentRun = Binding.Service<CreateAgentRun>(
  "Azure.CognitiveServices.CreateAgentRun",
);
