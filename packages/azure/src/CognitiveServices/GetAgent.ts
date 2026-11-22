import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetAgentRequest extends Omit<agents.GetAgentRequest, "endpoint"> {}

/**
 * Retrieves an existing agent.
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
 * {@link GetAgentHttp}.
 *
 * ### Calling GetAgent
 * **Example:** GetAgent from a Function
 * ```typescript
 * // init
 * const getAgent = yield* Azure.CognitiveServices.GetAgent(project);
 *
 * // runtime
 * const result = yield* getAgent({ assistantId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAgent extends Binding.Service<
  GetAgent,
  "Azure.CognitiveServices.GetAgent",
  (
    project: Project,
  ) => Effect.Effect<
    (request: GetAgentRequest) => Effect.Effect<agents.Agent, agents.GetAgentError, RuntimeContext>
  >
> {}

export const GetAgent = Binding.Service<GetAgent>("Azure.CognitiveServices.GetAgent");
