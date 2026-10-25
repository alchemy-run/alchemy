import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { SubmitAgentRunToolOutputs } from "./SubmitAgentRunToolOutputs.ts";

/**
 * Implementation of {@link SubmitAgentRunToolOutputs} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.SubmitAgentRunToolOutputs
 */
export const SubmitAgentRunToolOutputsHttp = Layer.effect(
  SubmitAgentRunToolOutputs,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.SubmitAgentRunToolOutputs",
    operation: agents.SubmitRunToolOutputsToRun,
    grant: AIRole.AgentsWrite,
  }),
);
