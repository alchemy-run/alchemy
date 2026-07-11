import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export interface InvokeCodeInterpreterRequest extends Omit<
  agentcore.InvokeCodeInterpreterRequest,
  "codeInterpreterIdentifier"
> {}

/**
 * Executes a tool (e.g. `executeCode`) inside a code interpreter session. The response carries a result stream.
 * @binding
 */
export interface InvokeCodeInterpreter extends Binding.Service<
  InvokeCodeInterpreter,
  "AWS.BedrockAgentCore.InvokeCodeInterpreter",
  <R extends CodeInterpreter>(
    codeInterpreter: R,
  ) => Effect.Effect<
    (
      request: InvokeCodeInterpreterRequest,
    ) => Effect.Effect<
      agentcore.InvokeCodeInterpreterResponse,
      agentcore.InvokeCodeInterpreterError
    >
  >
> {}
export const InvokeCodeInterpreter = Binding.Service<InvokeCodeInterpreter>(
  "AWS.BedrockAgentCore.InvokeCodeInterpreter",
);
