import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentFile } from "./GetAgentFile.ts";

/**
 * Implementation of {@link GetAgentFile} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentFile
 */
export const GetAgentFileHttp = Layer.effect(
  GetAgentFile,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentFile",
    operation: agents.GetFileFile,
    grant: AIRole.AgentsRead,
  }),
);
