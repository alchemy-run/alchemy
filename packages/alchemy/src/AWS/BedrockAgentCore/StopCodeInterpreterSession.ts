import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export interface StopCodeInterpreterSessionRequest extends Omit<
  agentcore.StopCodeInterpreterSessionRequest,
  "codeInterpreterIdentifier"
> {}

/**
 * Stops a running code interpreter session.
 * @binding
 */
export interface StopCodeInterpreterSession extends Binding.Service<
  StopCodeInterpreterSession,
  "AWS.BedrockAgentCore.StopCodeInterpreterSession",
  <R extends CodeInterpreter>(
    codeInterpreter: R,
  ) => Effect.Effect<
    (
      request: StopCodeInterpreterSessionRequest,
    ) => Effect.Effect<
      agentcore.StopCodeInterpreterSessionResponse,
      agentcore.StopCodeInterpreterSessionError
    >
  >
> {}
export const StopCodeInterpreterSession =
  Binding.Service<StopCodeInterpreterSession>(
    "AWS.BedrockAgentCore.StopCodeInterpreterSession",
  );
