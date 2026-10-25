import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { UpdateAgentVectorStore } from "./UpdateAgentVectorStore.ts";

/**
 * Implementation of {@link UpdateAgentVectorStore} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateAgentVectorStore
 */
export const UpdateAgentVectorStoreHttp = Layer.effect(
  UpdateAgentVectorStore,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.UpdateAgentVectorStore",
    operation: agents.ModifyVectorStoreVectorStore,
    grant: AIRole.AgentsWrite,
  }),
);
