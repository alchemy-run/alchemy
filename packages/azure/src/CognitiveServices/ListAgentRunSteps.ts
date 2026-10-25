import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListAgentRunStepsRequest extends Omit<
  agents.ListRunStepRunStepsRequest,
  "endpoint"
> {}

/**
 * Gets a list of run steps from a thread run.
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
 * {@link ListAgentRunStepsHttp}.
 *
 * ### Calling ListAgentRunSteps
 * **Example:** ListAgentRunSteps from a Function
 * ```typescript
 * // init
 * const listAgentRunSteps = yield* Azure.CognitiveServices.ListAgentRunSteps(project);
 *
 * // runtime
 * const result = yield* listAgentRunSteps({ threadId, runId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListAgentRunSteps extends Binding.Service<
  ListAgentRunSteps,
  "Azure.CognitiveServices.ListAgentRunSteps",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListAgentRunStepsRequest,
    ) => Effect.Effect<
      agents.ListRunStepRunStepsResponse,
      agents.ListRunStepRunStepsError,
      RuntimeContext
    >
  >
> {}

export const ListAgentRunSteps = Binding.Service<ListAgentRunSteps>(
  "Azure.CognitiveServices.ListAgentRunSteps",
);
