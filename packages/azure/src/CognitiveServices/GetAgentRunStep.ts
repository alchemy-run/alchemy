import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetAgentRunStepRequest extends Omit<agents.GetRunStepRunStepRequest, "endpoint"> {}

/**
 * Retrieves a single run step from a thread run.
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
 * {@link GetAgentRunStepHttp}.
 *
 * ### Calling GetAgentRunStep
 * **Example:** GetAgentRunStep from a Function
 * ```typescript
 * // init
 * const getAgentRunStep = yield* Azure.CognitiveServices.GetAgentRunStep(project);
 *
 * // runtime
 * const result = yield* getAgentRunStep({ threadId, runId, stepId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAgentRunStep extends Binding.Service<
  GetAgentRunStep,
  "Azure.CognitiveServices.GetAgentRunStep",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetAgentRunStepRequest,
    ) => Effect.Effect<agents.RunStep, agents.GetRunStepRunStepError, RuntimeContext>
  >
> {}

export const GetAgentRunStep = Binding.Service<GetAgentRunStep>(
  "Azure.CognitiveServices.GetAgentRunStep",
);
