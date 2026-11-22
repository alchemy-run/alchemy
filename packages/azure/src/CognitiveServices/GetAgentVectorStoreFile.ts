import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetAgentVectorStoreFileRequest extends Omit<
  agents.GetVectorStoreFileVectorStoreFileRequest,
  "endpoint"
> {}

/**
 * Retrieves a vector store file.
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
 * {@link GetAgentVectorStoreFileHttp}.
 *
 * ### Calling GetAgentVectorStoreFile
 * **Example:** GetAgentVectorStoreFile from a Function
 * ```typescript
 * // init
 * const getAgentVectorStoreFile = yield* Azure.CognitiveServices.GetAgentVectorStoreFile(project);
 *
 * // runtime
 * const result = yield* getAgentVectorStoreFile({ vectorStoreId, fileId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAgentVectorStoreFile extends Binding.Service<
  GetAgentVectorStoreFile,
  "Azure.CognitiveServices.GetAgentVectorStoreFile",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetAgentVectorStoreFileRequest,
    ) => Effect.Effect<
      agents.VectorStoreFile,
      agents.GetVectorStoreFileVectorStoreFileError,
      RuntimeContext
    >
  >
> {}

export const GetAgentVectorStoreFile = Binding.Service<GetAgentVectorStoreFile>(
  "Azure.CognitiveServices.GetAgentVectorStoreFile",
);
