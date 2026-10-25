import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgentFiles } from "./ListAgentFiles.ts";

/**
 * Implementation of {@link ListAgentFiles} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgentFiles
 */
export const ListAgentFilesHttp = Layer.effect(
  ListAgentFiles,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgentFiles",
    operation: agents.ListFileFiles,
    grant: AIRole.AgentsRead,
  }),
);
