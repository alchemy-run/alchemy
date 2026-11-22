import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface UploadAgentFileRequest extends Omit<agents.UploadFileFileRequest, "endpoint"> {}

/**
 * Uploads a file for use by other operations.
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
 * {@link UploadAgentFileHttp}.
 *
 * ### Calling UploadAgentFile
 * **Example:** UploadAgentFile from a Function
 * ```typescript
 * // init
 * const uploadAgentFile = yield* Azure.CognitiveServices.UploadAgentFile(project);
 *
 * // runtime
 * const result = yield* uploadAgentFile();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UploadAgentFile extends Binding.Service<
  UploadAgentFile,
  "Azure.CognitiveServices.UploadAgentFile",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: UploadAgentFileRequest,
    ) => Effect.Effect<agents.FileInfo, agents.UploadFileFileError, RuntimeContext>
  >
> {}

export const UploadAgentFile = Binding.Service<UploadAgentFile>(
  "Azure.CognitiveServices.UploadAgentFile",
);
