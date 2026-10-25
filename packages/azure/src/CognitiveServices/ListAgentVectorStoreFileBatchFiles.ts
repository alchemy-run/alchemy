import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListAgentVectorStoreFileBatchFilesRequest extends Omit<
  agents.ListVectorStoreFileBatchVectorStoreFileBatchFilesRequest,
  "endpoint"
> {}

/**
 * Returns a list of vector store files in a batch.
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
 * {@link ListAgentVectorStoreFileBatchFilesHttp}.
 *
 * ### Calling ListAgentVectorStoreFileBatchFiles
 * **Example:** ListAgentVectorStoreFileBatchFiles from a Function
 * ```typescript
 * // init
 * const listAgentVectorStoreFileBatchFiles = yield* Azure.CognitiveServices.ListAgentVectorStoreFileBatchFiles(project);
 *
 * // runtime
 * const result = yield* listAgentVectorStoreFileBatchFiles({ vectorStoreId, batchId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListAgentVectorStoreFileBatchFiles extends Binding.Service<
  ListAgentVectorStoreFileBatchFiles,
  "Azure.CognitiveServices.ListAgentVectorStoreFileBatchFiles",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListAgentVectorStoreFileBatchFilesRequest,
    ) => Effect.Effect<
      agents.ListVectorStoreFileBatchVectorStoreFileBatchFilesResponse,
      agents.ListVectorStoreFileBatchVectorStoreFileBatchFilesError,
      RuntimeContext
    >
  >
> {}

export const ListAgentVectorStoreFileBatchFiles =
  Binding.Service<ListAgentVectorStoreFileBatchFiles>(
    "Azure.CognitiveServices.ListAgentVectorStoreFileBatchFiles",
  );
