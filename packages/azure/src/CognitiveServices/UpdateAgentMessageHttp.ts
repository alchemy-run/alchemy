import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { UpdateAgentMessage } from "./UpdateAgentMessage.ts";

/**
 * Implementation of {@link UpdateAgentMessage} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateAgentMessage
 */
export const UpdateAgentMessageHttp = Layer.effect(
  UpdateAgentMessage,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.UpdateAgentMessage",
    operation: agents.UpdateMessageMessage,
    grant: AIRole.AgentsWrite,
  }),
);
