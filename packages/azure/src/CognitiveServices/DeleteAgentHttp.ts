import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { DeleteAgent } from "./DeleteAgent.ts";

/**
 * Implementation of {@link DeleteAgent} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsDeleteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteAgent
 */
export const DeleteAgentHttp = Layer.effect(
  DeleteAgent,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.DeleteAgent",
    operation: agents.DeleteAgent,
    grant: AIRole.AgentsDelete,
  }),
);
