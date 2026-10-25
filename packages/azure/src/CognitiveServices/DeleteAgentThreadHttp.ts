import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { DeleteAgentThread } from "./DeleteAgentThread.ts";

/**
 * Implementation of {@link DeleteAgentThread} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsDeleteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteAgentThread
 */
export const DeleteAgentThreadHttp = Layer.effect(
  DeleteAgentThread,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.DeleteAgentThread",
    operation: agents.DeleteThreadThread,
    grant: AIRole.AgentsDelete,
  }),
);
