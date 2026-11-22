import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { UpdateAgentThread } from "./UpdateAgentThread.ts";

/**
 * Implementation of {@link UpdateAgentThread} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateAgentThread
 */
export const UpdateAgentThreadHttp = Layer.effect(
  UpdateAgentThread,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.UpdateAgentThread",
    operation: agents.UpdateThreadThread,
    grant: AIRole.AgentsWrite,
  }),
);
