import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DeleteAgentVectorStoreRequest extends Omit<
  agents.DeleteVectorStoreVectorStoreRequest,
  "endpoint"
> {}

/**
 * Deletes the vector store object matching the specified ID.
 *
 * Binding assigns a custom role (`AzureAIAgentsDeleteRole`, one per stack)
 * with exactly the data action `AIServices/agents/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the Foundry project only. The
 * project's account must be an `AIServices` account with
 * `allowProjectManagement: true`. The built-in **Azure AI User** and
 * **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteAgentVectorStoreHttp}.
 *
 * ### Calling DeleteAgentVectorStore
 * **Example:** DeleteAgentVectorStore from a Function
 * ```typescript
 * // init
 * const deleteAgentVectorStore = yield* Azure.CognitiveServices.DeleteAgentVectorStore(project);
 *
 * // runtime
 * const result = yield* deleteAgentVectorStore({ vectorStoreId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteAgentVectorStore extends Binding.Service<
  DeleteAgentVectorStore,
  "Azure.CognitiveServices.DeleteAgentVectorStore",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DeleteAgentVectorStoreRequest,
    ) => Effect.Effect<
      agents.VectorStoreDeletionStatus,
      agents.DeleteVectorStoreVectorStoreError,
      RuntimeContext
    >
  >
> {}

export const DeleteAgentVectorStore = Binding.Service<DeleteAgentVectorStore>(
  "Azure.CognitiveServices.DeleteAgentVectorStore",
);
