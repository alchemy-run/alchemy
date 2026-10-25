import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DeleteAgentVectorStoreFileRequest extends Omit<
  agents.DeleteVectorStoreFileVectorStoreFileRequest,
  "endpoint"
> {}

/**
 * Deletes a vector store file. This removes the file-to-store link (does not
 * delete the file itself).
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
 * {@link DeleteAgentVectorStoreFileHttp}.
 *
 * ### Calling DeleteAgentVectorStoreFile
 * **Example:** DeleteAgentVectorStoreFile from a Function
 * ```typescript
 * // init
 * const deleteAgentVectorStoreFile = yield* Azure.CognitiveServices.DeleteAgentVectorStoreFile(project);
 *
 * // runtime
 * const result = yield* deleteAgentVectorStoreFile({ vectorStoreId, fileId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteAgentVectorStoreFile extends Binding.Service<
  DeleteAgentVectorStoreFile,
  "Azure.CognitiveServices.DeleteAgentVectorStoreFile",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DeleteAgentVectorStoreFileRequest,
    ) => Effect.Effect<
      agents.VectorStoreFileDeletionStatus,
      agents.DeleteVectorStoreFileVectorStoreFileError,
      RuntimeContext
    >
  >
> {}

export const DeleteAgentVectorStoreFile = Binding.Service<DeleteAgentVectorStoreFile>(
  "Azure.CognitiveServices.DeleteAgentVectorStoreFile",
);
