import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface UpdateAgentRunRequest extends Omit<agents.UpdateRunRunRequest, "endpoint"> {}

/**
 * Modifies an existing thread run.
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
 * {@link UpdateAgentRunHttp}.
 *
 * ### Calling UpdateAgentRun
 * **Example:** UpdateAgentRun from a Function
 * ```typescript
 * // init
 * const updateAgentRun = yield* Azure.CognitiveServices.UpdateAgentRun(project);
 *
 * // runtime
 * const result = yield* updateAgentRun({ threadId, runId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateAgentRun extends Binding.Service<
  UpdateAgentRun,
  "Azure.CognitiveServices.UpdateAgentRun",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: UpdateAgentRunRequest,
    ) => Effect.Effect<agents.ThreadRun, agents.UpdateRunRunError, RuntimeContext>
  >
> {}

export const UpdateAgentRun = Binding.Service<UpdateAgentRun>(
  "Azure.CognitiveServices.UpdateAgentRun",
);
