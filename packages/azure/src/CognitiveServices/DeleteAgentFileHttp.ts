import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { DeleteAgentFile } from "./DeleteAgentFile.ts";

/**
 * Implementation of {@link DeleteAgentFile} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsDeleteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteAgentFile
 */
export const DeleteAgentFileHttp = Layer.effect(
  DeleteAgentFile,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.DeleteAgentFile",
    operation: agents.DeleteFileFile,
    grant: AIRole.AgentsDelete,
  }),
);
