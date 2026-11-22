import * as agents from "@distilled.cloud/azure/ai-agents";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { CancelAgentRun } from "./CancelAgentRun.ts";

/**
 * Implementation of {@link CancelAgentRun} over the distilled `ai-agents`
 * data plane. Assigns the custom `AzureAIAgentsWriteRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.CancelAgentRun
 */
export const CancelAgentRunHttp = Layer.effect(
  CancelAgentRun,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.CancelAgentRun",
    operation: agents.CancelRunRun,
    grant: AIRole.AgentsWrite,
  }),
);
