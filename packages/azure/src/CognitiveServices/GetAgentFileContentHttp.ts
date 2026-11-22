import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentFileContent } from "./GetAgentFileContent.ts";

/**
 * Implementation of {@link GetAgentFileContent} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentFileContent
 */
export const GetAgentFileContentHttp = Layer.effect(
  GetAgentFileContent,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentFileContent",
    operation: agents.GetFileFileContent,
    grant: AIRole.AgentsRead,
  }),
);
