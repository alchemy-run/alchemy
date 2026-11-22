import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgent } from "./GetAgent.ts";

/**
 * Implementation of {@link GetAgent} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgent
 */
export const GetAgentHttp = Layer.effect(
  GetAgent,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgent",
    operation: agents.GetAgent,
    grant: AIRole.AgentsRead,
  }),
);
