import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Runtime } from "./Runtime.ts";

export interface InvokeAgentRuntimeRequest extends Omit<
  agentcore.InvokeAgentRuntimeRequest,
  "agentRuntimeArn"
> {}

/**
 * Sends a request to an agent hosted in an AgentCore Runtime and receives
 * the (optionally streaming) response.
 * @binding
 */
export interface InvokeAgentRuntime extends Binding.Service<
  InvokeAgentRuntime,
  "AWS.BedrockAgentCore.InvokeAgentRuntime",
  <R extends Runtime>(
    runtime: R,
  ) => Effect.Effect<
    (
      request: InvokeAgentRuntimeRequest,
    ) => Effect.Effect<
      agentcore.InvokeAgentRuntimeResponse,
      agentcore.InvokeAgentRuntimeError
    >
  >
> {}
export const InvokeAgentRuntime = Binding.Service<InvokeAgentRuntime>(
  "AWS.BedrockAgentCore.InvokeAgentRuntime",
);
