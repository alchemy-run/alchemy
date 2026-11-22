import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateAgentVectorStoreFileRequest extends Omit<
  agents.CreateVectorStoreFileVectorStoreFileRequest,
  "endpoint"
> {}

/**
 * Create a vector store file by attaching a file to a vector store.
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
 * {@link CreateAgentVectorStoreFileHttp}.
 *
 * ### Calling CreateAgentVectorStoreFile
 * **Example:** CreateAgentVectorStoreFile from a Function
 * ```typescript
 * // init
 * const createAgentVectorStoreFile = yield* Azure.CognitiveServices.CreateAgentVectorStoreFile(project);
 *
 * // runtime
 * const result = yield* createAgentVectorStoreFile({ vectorStoreId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateAgentVectorStoreFile extends Binding.Service<
  CreateAgentVectorStoreFile,
  "Azure.CognitiveServices.CreateAgentVectorStoreFile",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateAgentVectorStoreFileRequest,
    ) => Effect.Effect<
      agents.VectorStoreFile,
      agents.CreateVectorStoreFileVectorStoreFileError,
      RuntimeContext
    >
  >
> {}

export const CreateAgentVectorStoreFile = Binding.Service<CreateAgentVectorStoreFile>(
  "Azure.CognitiveServices.CreateAgentVectorStoreFile",
);
