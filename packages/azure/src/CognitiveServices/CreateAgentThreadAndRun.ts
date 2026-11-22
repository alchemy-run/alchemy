import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateAgentThreadAndRunRequest extends Omit<
  agents.CreateThreadAndRunRequest,
  "endpoint"
> {}

/**
 * Creates a new agent thread and immediately starts a run using that new
 * thread.
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
 * {@link CreateAgentThreadAndRunHttp}.
 *
 * ### Calling CreateAgentThreadAndRun
 * **Example:** CreateAgentThreadAndRun from a Function
 * ```typescript
 * // init
 * const createAgentThreadAndRun = yield* Azure.CognitiveServices.CreateAgentThreadAndRun(project);
 *
 * // runtime
 * const run = yield* createAgentThreadAndRun({
 *   assistant_id: agentId,
 *   thread: { messages: [{ role: "user", content: "Hello" }] },
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateAgentThreadAndRun extends Binding.Service<
  CreateAgentThreadAndRun,
  "Azure.CognitiveServices.CreateAgentThreadAndRun",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateAgentThreadAndRunRequest,
    ) => Effect.Effect<agents.ThreadRun, agents.CreateThreadAndRunError, RuntimeContext>
  >
> {}

export const CreateAgentThreadAndRun = Binding.Service<CreateAgentThreadAndRun>(
  "Azure.CognitiveServices.CreateAgentThreadAndRun",
);
