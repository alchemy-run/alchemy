import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetAgentVectorStoreRequest extends Omit<
  agents.GetVectorStoreVectorStoreRequest,
  "endpoint"
> {}

/**
 * Returns the vector store object matching the specified ID.
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
 * {@link GetAgentVectorStoreHttp}.
 *
 * ### Calling GetAgentVectorStore
 * **Example:** GetAgentVectorStore from a Function
 * ```typescript
 * // init
 * const getAgentVectorStore = yield* Azure.CognitiveServices.GetAgentVectorStore(project);
 *
 * // runtime
 * const result = yield* getAgentVectorStore({ vectorStoreId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAgentVectorStore extends Binding.Service<
  GetAgentVectorStore,
  "Azure.CognitiveServices.GetAgentVectorStore",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetAgentVectorStoreRequest,
    ) => Effect.Effect<agents.VectorStore, agents.GetVectorStoreVectorStoreError, RuntimeContext>
  >
> {}

export const GetAgentVectorStore = Binding.Service<GetAgentVectorStore>(
  "Azure.CognitiveServices.GetAgentVectorStore",
);
