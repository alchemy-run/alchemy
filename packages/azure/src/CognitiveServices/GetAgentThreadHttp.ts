import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetAgentThread } from "./GetAgentThread.ts";

/**
 * Implementation of {@link GetAgentThread} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAgentThread
 */
export const GetAgentThreadHttp = Layer.effect(
  GetAgentThread,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetAgentThread",
    operation: agents.GetThreadThread,
    grant: AIRole.AgentsRead,
  }),
);
