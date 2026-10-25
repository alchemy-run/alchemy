import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetAgentVectorStoreFileBatchRequest extends Omit<
  agents.GetVectorStoreFileBatchVectorStoreFileBatchRequest,
  "endpoint"
> {}

/**
 * Retrieve a vector store file batch.
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
 * {@link GetAgentVectorStoreFileBatchHttp}.
 *
 * ### Calling GetAgentVectorStoreFileBatch
 * **Example:** GetAgentVectorStoreFileBatch from a Function
 * ```typescript
 * // init
 * const getAgentVectorStoreFileBatch = yield* Azure.CognitiveServices.GetAgentVectorStoreFileBatch(project);
 *
 * // runtime
 * const result = yield* getAgentVectorStoreFileBatch({ vectorStoreId, batchId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAgentVectorStoreFileBatch extends Binding.Service<
  GetAgentVectorStoreFileBatch,
  "Azure.CognitiveServices.GetAgentVectorStoreFileBatch",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetAgentVectorStoreFileBatchRequest,
    ) => Effect.Effect<
      agents.VectorStoreFileBatch,
      agents.GetVectorStoreFileBatchVectorStoreFileBatchError,
      RuntimeContext
    >
  >
> {}

export const GetAgentVectorStoreFileBatch = Binding.Service<GetAgentVectorStoreFileBatch>(
  "Azure.CognitiveServices.GetAgentVectorStoreFileBatch",
);
