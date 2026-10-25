import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateAgentVectorStoreFileBatchRequest extends Omit<
  agents.CreateVectorStoreFileBatchVectorStoreFileBatchRequest,
  "endpoint"
> {}

/**
 * Create a vector store file batch.
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
 * {@link CreateAgentVectorStoreFileBatchHttp}.
 *
 * ### Calling CreateAgentVectorStoreFileBatch
 * **Example:** CreateAgentVectorStoreFileBatch from a Function
 * ```typescript
 * // init
 * const createAgentVectorStoreFileBatch = yield* Azure.CognitiveServices.CreateAgentVectorStoreFileBatch(project);
 *
 * // runtime
 * const result = yield* createAgentVectorStoreFileBatch({ vectorStoreId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateAgentVectorStoreFileBatch extends Binding.Service<
  CreateAgentVectorStoreFileBatch,
  "Azure.CognitiveServices.CreateAgentVectorStoreFileBatch",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateAgentVectorStoreFileBatchRequest,
    ) => Effect.Effect<
      agents.VectorStoreFileBatch,
      agents.CreateVectorStoreFileBatchVectorStoreFileBatchError,
      RuntimeContext
    >
  >
> {}

export const CreateAgentVectorStoreFileBatch = Binding.Service<CreateAgentVectorStoreFileBatch>(
  "Azure.CognitiveServices.CreateAgentVectorStoreFileBatch",
);
