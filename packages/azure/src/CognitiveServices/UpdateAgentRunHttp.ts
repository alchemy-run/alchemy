import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { UpdateAgentRun } from "./UpdateAgentRun.ts";

/**
 * Implementation of {@link UpdateAgentRun} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateAgentRun
 */
export const UpdateAgentRunHttp = Layer.effect(
  UpdateAgentRun,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.UpdateAgentRun",
    operation: agents.UpdateRunRun,
    grant: AIRole.AgentsWrite,
  }),
);
