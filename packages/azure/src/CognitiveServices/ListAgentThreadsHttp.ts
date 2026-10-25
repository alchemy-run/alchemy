import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgentThreads } from "./ListAgentThreads.ts";

/**
 * Implementation of {@link ListAgentThreads} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgentThreads
 */
export const ListAgentThreadsHttp = Layer.effect(
  ListAgentThreads,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgentThreads",
    operation: agents.ListThreadThreads,
    grant: AIRole.AgentsRead,
  }),
);
