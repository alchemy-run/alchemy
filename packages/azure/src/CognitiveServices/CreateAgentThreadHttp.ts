import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateAgentThread } from "./CreateAgentThread.ts";

/**
 * Implementation of {@link CreateAgentThread} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateAgentThread
 */
export const CreateAgentThreadHttp = Layer.effect(
  CreateAgentThread,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateAgentThread",
    operation: agents.CreateThreadThread,
    grant: AIRole.AgentsWrite,
  }),
);
