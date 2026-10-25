import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateAgentVectorStoreFile } from "./CreateAgentVectorStoreFile.ts";

/**
 * Implementation of {@link CreateAgentVectorStoreFile} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateAgentVectorStoreFile
 */
export const CreateAgentVectorStoreFileHttp = Layer.effect(
  CreateAgentVectorStoreFile,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateAgentVectorStoreFile",
    operation: agents.CreateVectorStoreFileVectorStoreFile,
    grant: AIRole.AgentsWrite,
  }),
);
