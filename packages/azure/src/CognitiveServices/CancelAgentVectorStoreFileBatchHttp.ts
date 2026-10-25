import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CancelAgentVectorStoreFileBatch } from "./CancelAgentVectorStoreFileBatch.ts";

/**
 * Implementation of {@link CancelAgentVectorStoreFileBatch} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CancelAgentVectorStoreFileBatch
 */
export const CancelAgentVectorStoreFileBatchHttp = Layer.effect(
  CancelAgentVectorStoreFileBatch,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CancelAgentVectorStoreFileBatch",
    operation: agents.CancelVectorStoreFileBatchVectorStoreFileBatch,
    grant: AIRole.AgentsWrite,
  }),
);
