import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DeleteAgentThreadRequest extends Omit<
  agents.DeleteThreadThreadRequest,
  "endpoint"
> {}

/**
 * Deletes an existing thread.
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
 * {@link DeleteAgentThreadHttp}.
 *
 * ### Calling DeleteAgentThread
 * **Example:** DeleteAgentThread from a Function
 * ```typescript
 * // init
 * const deleteAgentThread = yield* Azure.CognitiveServices.DeleteAgentThread(project);
 *
 * // runtime
 * const result = yield* deleteAgentThread({ threadId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteAgentThread extends Binding.Service<
  DeleteAgentThread,
  "Azure.CognitiveServices.DeleteAgentThread",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DeleteAgentThreadRequest,
    ) => Effect.Effect<agents.ThreadDeletionStatus, agents.DeleteThreadThreadError, RuntimeContext>
  >
> {}

export const DeleteAgentThread = Binding.Service<DeleteAgentThread>(
  "Azure.CognitiveServices.DeleteAgentThread",
);
