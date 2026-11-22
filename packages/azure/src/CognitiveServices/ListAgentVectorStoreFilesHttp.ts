import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgentVectorStoreFiles } from "./ListAgentVectorStoreFiles.ts";

/**
 * Implementation of {@link ListAgentVectorStoreFiles} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgentVectorStoreFiles
 */
export const ListAgentVectorStoreFilesHttp = Layer.effect(
  ListAgentVectorStoreFiles,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgentVectorStoreFiles",
    operation: agents.ListVectorStoreFileVectorStoreFiles,
    grant: AIRole.AgentsRead,
  }),
);
