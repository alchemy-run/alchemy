import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListAgentFilesRequest extends Omit<agents.ListFileFilesRequest, "endpoint"> {}

/**
 * Gets a list of previously uploaded files.
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
 * {@link ListAgentFilesHttp}.
 *
 * ### Calling ListAgentFiles
 * **Example:** ListAgentFiles from a Function
 * ```typescript
 * // init
 * const listAgentFiles = yield* Azure.CognitiveServices.ListAgentFiles(project);
 *
 * // runtime
 * const result = yield* listAgentFiles();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListAgentFiles extends Binding.Service<
  ListAgentFiles,
  "Azure.CognitiveServices.ListAgentFiles",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListAgentFilesRequest,
    ) => Effect.Effect<agents.FileListResponse, agents.ListFileFilesError, RuntimeContext>
  >
> {}

export const ListAgentFiles = Binding.Service<ListAgentFiles>(
  "Azure.CognitiveServices.ListAgentFiles",
);
