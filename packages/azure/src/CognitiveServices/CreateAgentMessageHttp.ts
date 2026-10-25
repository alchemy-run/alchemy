import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateAgentMessage } from "./CreateAgentMessage.ts";

/**
 * Implementation of {@link CreateAgentMessage} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateAgentMessage
 */
export const CreateAgentMessageHttp = Layer.effect(
  CreateAgentMessage,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateAgentMessage",
    operation: agents.CreateMessageMessage,
    grant: AIRole.AgentsWrite,
  }),
);
