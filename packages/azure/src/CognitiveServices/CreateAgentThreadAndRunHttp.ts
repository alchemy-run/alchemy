import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CreateAgentThreadAndRun } from "./CreateAgentThreadAndRun.ts";

/**
 * Implementation of {@link CreateAgentThreadAndRun} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateAgentThreadAndRun
 */
export const CreateAgentThreadAndRunHttp = Layer.effect(
  CreateAgentThreadAndRun,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CreateAgentThreadAndRun",
    operation: agents.CreateThreadAndRun,
    grant: AIRole.AgentsWrite,
  }),
);
