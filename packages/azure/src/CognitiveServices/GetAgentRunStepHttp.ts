import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentRunStep } from "./GetAgentRunStep.ts";

/**
 * Implementation of {@link GetAgentRunStep} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentRunStep
 */
export const GetAgentRunStepHttp = Layer.effect(
  GetAgentRunStep,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentRunStep",
    operation: agents.GetRunStepRunStep,
    grant: AIRole.AgentsRead,
  }),
);
