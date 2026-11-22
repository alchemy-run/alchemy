import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentRun } from "./GetAgentRun.ts";

/**
 * Implementation of {@link GetAgentRun} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentRun
 */
export const GetAgentRunHttp = Layer.effect(
  GetAgentRun,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentRun",
    operation: agents.GetRunRun,
    grant: AIRole.AgentsRead,
  }),
);
