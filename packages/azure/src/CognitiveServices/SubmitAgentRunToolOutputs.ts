import type * as agents from "@distilled.cloud/azure/ai-agents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface SubmitAgentRunToolOutputsRequest extends Omit<
  agents.SubmitRunToolOutputsToRunRequest,
  "endpoint"
> {}

/**
 * Submits outputs from tools as requested by tool calls in a run.
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
 * {@link SubmitAgentRunToolOutputsHttp}.
 *
 * ### Calling SubmitAgentRunToolOutputs
 * **Example:** SubmitAgentRunToolOutputs from a Function
 * ```typescript
 * // init
 * const submitAgentRunToolOutputs = yield* Azure.CognitiveServices.SubmitAgentRunToolOutputs(project);
 *
 * // runtime
 * const result = yield* submitAgentRunToolOutputs({ threadId, runId, tool_outputs });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface SubmitAgentRunToolOutputs extends Binding.Service<
  SubmitAgentRunToolOutputs,
  "Azure.CognitiveServices.SubmitAgentRunToolOutputs",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: SubmitAgentRunToolOutputsRequest,
    ) => Effect.Effect<agents.ThreadRun, agents.SubmitRunToolOutputsToRunError, RuntimeContext>
  >
> {}

export const SubmitAgentRunToolOutputs = Binding.Service<SubmitAgentRunToolOutputs>(
  "Azure.CognitiveServices.SubmitAgentRunToolOutputs",
);
