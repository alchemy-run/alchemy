import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgentVectorStoreFileBatchFiles } from "./ListAgentVectorStoreFileBatchFiles.ts";

/**
 * Implementation of {@link ListAgentVectorStoreFileBatchFiles} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgentVectorStoreFileBatchFiles
 */
export const ListAgentVectorStoreFileBatchFilesHttp = Layer.effect(
  ListAgentVectorStoreFileBatchFiles,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgentVectorStoreFileBatchFiles",
    operation: agents.ListVectorStoreFileBatchVectorStoreFileBatchFiles,
    grant: AIRole.AgentsRead,
  }),
);
