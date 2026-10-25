import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentVectorStoreFileBatch } from "./GetAgentVectorStoreFileBatch.ts";

/**
 * Implementation of {@link GetAgentVectorStoreFileBatch} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentVectorStoreFileBatch
 */
export const GetAgentVectorStoreFileBatchHttp = Layer.effect(
  GetAgentVectorStoreFileBatch,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentVectorStoreFileBatch",
    operation: agents.GetVectorStoreFileBatchVectorStoreFileBatch,
    grant: AIRole.AgentsRead,
  }),
);
