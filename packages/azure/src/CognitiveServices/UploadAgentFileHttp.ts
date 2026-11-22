import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { UploadAgentFile } from "./UploadAgentFile.ts";

/**
 * Implementation of {@link UploadAgentFile} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.UploadAgentFile
 */
export const UploadAgentFileHttp = Layer.effect(
  UploadAgentFile,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.UploadAgentFile",
    operation: agents.UploadFileFile,
    grant: AIRole.AgentsWrite,
  }),
);
