import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { DeleteAgentVectorStoreFile } from "./DeleteAgentVectorStoreFile.ts";

/**
 * Implementation of {@link DeleteAgentVectorStoreFile} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsDeleteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteAgentVectorStoreFile
 */
export const DeleteAgentVectorStoreFileHttp = Layer.effect(
  DeleteAgentVectorStoreFile,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.DeleteAgentVectorStoreFile",
    operation: agents.DeleteVectorStoreFileVectorStoreFile,
    grant: AIRole.AgentsDelete,
  }),
);
