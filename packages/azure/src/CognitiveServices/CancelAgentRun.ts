import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CancelAgentRunRequest extends Omit<agents.CancelRunRunRequest, "endpoint"> {}

/**
 * Cancels a run of an in-progress thread.
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
 * {@link CancelAgentRunHttp}.
 *
 * ### Calling CancelAgentRun
 * **Example:** CancelAgentRun from a Function
 * ```typescript
 * // init
 * const cancelAgentRun = yield* Azure.CognitiveServices.CancelAgentRun(project);
 *
 * // runtime
 * const result = yield* cancelAgentRun({ threadId, runId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CancelAgentRun extends Binding.Service<
  CancelAgentRun,
  "Azure.CognitiveServices.CancelAgentRun",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CancelAgentRunRequest,
    ) => Effect.Effect<agents.ThreadRun, agents.CancelRunRunError, RuntimeContext>
  >
> {}

export const CancelAgentRun = Binding.Service<CancelAgentRun>(
  "Azure.CognitiveServices.CancelAgentRun",
);
