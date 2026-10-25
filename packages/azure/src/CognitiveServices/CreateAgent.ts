import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateAgentRequest extends Omit<agents.CreateAgentRequest, "endpoint"> {}

/**
 * Creates a new agent.
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
 * {@link CreateAgentHttp}.
 *
 * ### Calling CreateAgent
 * **Example:** CreateAgent from a Function
 * ```typescript
 * // init
 * const createAgent = yield* Azure.CognitiveServices.CreateAgent(project);
 *
 * // runtime
 * const agent = yield* createAgent({
 *   model: "gpt-4.1-mini",
 *   name: "support",
 *   instructions: "Answer in one sentence.",
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateAgent extends Binding.Service<
  CreateAgent,
  "Azure.CognitiveServices.CreateAgent",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateAgentRequest,
    ) => Effect.Effect<agents.Agent, agents.CreateAgentError, RuntimeContext>
  >
> {}

export const CreateAgent = Binding.Service<CreateAgent>("Azure.CognitiveServices.CreateAgent");
