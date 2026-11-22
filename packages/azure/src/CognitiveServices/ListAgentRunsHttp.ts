import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgentRuns } from "./ListAgentRuns.ts";

/**
 * Implementation of {@link ListAgentRuns} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgentRuns
 */
export const ListAgentRunsHttp = Layer.effect(
  ListAgentRuns,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgentRuns",
    operation: agents.ListRunRuns,
    grant: AIRole.AgentsRead,
  }),
);
