import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentMessage } from "./GetAgentMessage.ts";

/**
 * Implementation of {@link GetAgentMessage} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentMessage
 */
export const GetAgentMessageHttp = Layer.effect(
  GetAgentMessage,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentMessage",
    operation: agents.GetMessageMessage,
    grant: AIRole.AgentsRead,
  }),
);
