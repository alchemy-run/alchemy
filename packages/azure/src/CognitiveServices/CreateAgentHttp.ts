import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateAgent } from "./CreateAgent.ts";

/**
 * Implementation of {@link CreateAgent} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateAgent
 */
export const CreateAgentHttp = Layer.effect(
  CreateAgent,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateAgent",
    operation: agents.CreateAgent,
    grant: AIRole.AgentsWrite,
  }),
);
