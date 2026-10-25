import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DeleteAgentFileRequest extends Omit<agents.DeleteFileFileRequest, "endpoint"> {}

/**
 * Delete a previously uploaded file.
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
 * {@link DeleteAgentFileHttp}.
 *
 * ### Calling DeleteAgentFile
 * **Example:** DeleteAgentFile from a Function
 * ```typescript
 * // init
 * const deleteAgentFile = yield* Azure.CognitiveServices.DeleteAgentFile(project);
 *
 * // runtime
 * const result = yield* deleteAgentFile({ fileId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteAgentFile extends Binding.Service<
  DeleteAgentFile,
  "Azure.CognitiveServices.DeleteAgentFile",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DeleteAgentFileRequest,
    ) => Effect.Effect<agents.FileDeletionStatus, agents.DeleteFileFileError, RuntimeContext>
  >
> {}

export const DeleteAgentFile = Binding.Service<DeleteAgentFile>(
  "Azure.CognitiveServices.DeleteAgentFile",
);
