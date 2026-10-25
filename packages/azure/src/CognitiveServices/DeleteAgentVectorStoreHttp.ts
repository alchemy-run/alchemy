import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { DeleteAgentVectorStore } from "./DeleteAgentVectorStore.ts";

/**
 * Implementation of {@link DeleteAgentVectorStore} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsDeleteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteAgentVectorStore
 */
export const DeleteAgentVectorStoreHttp = Layer.effect(
  DeleteAgentVectorStore,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.DeleteAgentVectorStore",
    operation: agents.DeleteVectorStoreVectorStore,
    grant: AIRole.AgentsDelete,
  }),
);
