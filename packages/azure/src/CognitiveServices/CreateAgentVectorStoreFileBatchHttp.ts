import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateAgentVectorStoreFileBatch } from "./CreateAgentVectorStoreFileBatch.ts";

/**
 * Implementation of {@link CreateAgentVectorStoreFileBatch} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateAgentVectorStoreFileBatch
 */
export const CreateAgentVectorStoreFileBatchHttp = Layer.effect(
  CreateAgentVectorStoreFileBatch,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateAgentVectorStoreFileBatch",
    operation: agents.CreateVectorStoreFileBatchVectorStoreFileBatch,
    grant: AIRole.AgentsWrite,
  }),
);
