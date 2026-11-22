import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentVectorStore } from "./GetAgentVectorStore.ts";

/**
 * Implementation of {@link GetAgentVectorStore} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentVectorStore
 */
export const GetAgentVectorStoreHttp = Layer.effect(
  GetAgentVectorStore,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentVectorStore",
    operation: agents.GetVectorStoreVectorStore,
    grant: AIRole.AgentsRead,
  }),
);
