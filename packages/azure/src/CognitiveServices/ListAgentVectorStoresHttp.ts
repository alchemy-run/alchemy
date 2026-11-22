import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgentVectorStores } from "./ListAgentVectorStores.ts";

/**
 * Implementation of {@link ListAgentVectorStores} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgentVectorStores
 */
export const ListAgentVectorStoresHttp = Layer.effect(
  ListAgentVectorStores,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgentVectorStores",
    operation: agents.ListVectorStoreVectorStores,
    grant: AIRole.AgentsRead,
  }),
);
