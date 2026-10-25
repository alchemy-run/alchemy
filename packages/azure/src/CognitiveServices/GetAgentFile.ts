import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetAgentFileRequest extends Omit<agents.GetFileFileRequest, "endpoint"> {}

/**
 * Returns information about a specific file. Does not retrieve file content.
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
 * {@link GetAgentFileHttp}.
 *
 * ### Calling GetAgentFile
 * **Example:** GetAgentFile from a Function
 * ```typescript
 * // init
 * const getAgentFile = yield* Azure.CognitiveServices.GetAgentFile(project);
 *
 * // runtime
 * const result = yield* getAgentFile({ fileId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAgentFile extends Binding.Service<
  GetAgentFile,
  "Azure.CognitiveServices.GetAgentFile",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetAgentFileRequest,
    ) => Effect.Effect<agents.FileInfo, agents.GetFileFileError, RuntimeContext>
  >
> {}

export const GetAgentFile = Binding.Service<GetAgentFile>("Azure.CognitiveServices.GetAgentFile");
