import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export interface StartCodeInterpreterSessionRequest extends Omit<
  agentcore.StartCodeInterpreterSessionRequest,
  "codeInterpreterIdentifier"
> {}

/**
 * Starts an isolated code-execution session on a code interpreter.
 * @binding
 */
export interface StartCodeInterpreterSession extends Binding.Service<
  StartCodeInterpreterSession,
  "AWS.BedrockAgentCore.StartCodeInterpreterSession",
  <R extends CodeInterpreter>(
    codeInterpreter: R,
  ) => Effect.Effect<
    (
      request: StartCodeInterpreterSessionRequest,
    ) => Effect.Effect<
      agentcore.StartCodeInterpreterSessionResponse,
      agentcore.StartCodeInterpreterSessionError
    >
  >
> {}
export const StartCodeInterpreterSession =
  Binding.Service<StartCodeInterpreterSession>(
    "AWS.BedrockAgentCore.StartCodeInterpreterSession",
  );
