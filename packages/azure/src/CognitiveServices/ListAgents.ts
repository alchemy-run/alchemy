import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListAgentsRequest extends Omit<agents.ListAgentsRequest, "endpoint"> {}

/**
 * Gets a list of agents that were previously created.
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
 * {@link ListAgentsHttp}.
 *
 * ### Calling ListAgents
 * **Example:** ListAgents from a Function
 * ```typescript
 * // init
 * const listAgents = yield* Azure.CognitiveServices.ListAgents(project);
 *
 * // runtime
 * const { data } = yield* listAgents({ limit: 20 });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListAgents extends Binding.Service<
  ListAgents,
  "Azure.CognitiveServices.ListAgents",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListAgentsRequest,
    ) => Effect.Effect<agents.ListAgentsResponse, agents.ListAgentsError, RuntimeContext>
  >
> {}

export const ListAgents = Binding.Service<ListAgents>("Azure.CognitiveServices.ListAgents");
