import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgentMessages } from "./ListAgentMessages.ts";

/**
 * Implementation of {@link ListAgentMessages} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgentMessages
 */
export const ListAgentMessagesHttp = Layer.effect(
  ListAgentMessages,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgentMessages",
    operation: agents.ListMessageMessages,
    grant: AIRole.AgentsRead,
  }),
);
