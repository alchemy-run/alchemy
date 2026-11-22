import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { UpdateAgent } from "./UpdateAgent.ts";

/**
 * Implementation of {@link UpdateAgent} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateAgent
 */
export const UpdateAgentHttp = Layer.effect(
  UpdateAgent,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.UpdateAgent",
    operation: agents.UpdateAgent,
    grant: AIRole.AgentsWrite,
  }),
);
