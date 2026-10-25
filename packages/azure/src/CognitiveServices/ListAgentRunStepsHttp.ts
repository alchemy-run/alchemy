import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgentRunSteps } from "./ListAgentRunSteps.ts";

/**
 * Implementation of {@link ListAgentRunSteps} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgentRunSteps
 */
export const ListAgentRunStepsHttp = Layer.effect(
  ListAgentRunSteps,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgentRunSteps",
    operation: agents.ListRunStepRunSteps,
    grant: AIRole.AgentsRead,
  }),
);
