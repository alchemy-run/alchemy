import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentVectorStoreFile } from "./GetAgentVectorStoreFile.ts";

/**
 * Implementation of {@link GetAgentVectorStoreFile} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentVectorStoreFile
 */
export const GetAgentVectorStoreFileHttp = Layer.effect(
  GetAgentVectorStoreFile,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentVectorStoreFile",
    operation: agents.GetVectorStoreFileVectorStoreFile,
    grant: AIRole.AgentsRead,
  }),
);
