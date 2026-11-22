import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListAgents } from "./ListAgents.ts";

/**
 * Implementation of {@link ListAgents} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListAgents
 */
export const ListAgentsHttp = Layer.effect(
  ListAgents,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListAgents",
    operation: agents.ListAgents,
    grant: AIRole.AgentsRead,
  }),
);
