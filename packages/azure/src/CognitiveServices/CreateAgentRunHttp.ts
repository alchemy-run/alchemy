import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateAgentRun } from "./CreateAgentRun.ts";

/**
 * Implementation of {@link CreateAgentRun} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateAgentRun
 */
export const CreateAgentRunHttp = Layer.effect(
  CreateAgentRun,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateAgentRun",
    operation: agents.CreateRunRun,
    grant: AIRole.AgentsWrite,
  }),
);
