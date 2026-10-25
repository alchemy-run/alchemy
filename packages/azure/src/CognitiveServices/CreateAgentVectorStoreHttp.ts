import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateAgentVectorStore } from "./CreateAgentVectorStore.ts";

/**
 * Implementation of {@link CreateAgentVectorStore} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateAgentVectorStore
 */
export const CreateAgentVectorStoreHttp = Layer.effect(
  CreateAgentVectorStore,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateAgentVectorStore",
    operation: agents.CreateVectorStoreVectorStore,
    grant: AIRole.AgentsWrite,
  }),
);
