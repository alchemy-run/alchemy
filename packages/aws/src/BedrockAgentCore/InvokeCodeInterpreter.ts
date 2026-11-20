import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export interface InvokeCodeInterpreterRequest extends Omit<
  agentcore.InvokeCodeInterpreterRequest,
  "codeInterpreterIdentifier"
> {}

/**
 * Executes a tool (e.g. `executeCode`) inside a code interpreter session.
 * The response carries a result stream.
 *
 * Bind a {@link CodeInterpreter} inside a function runtime and call it with
 * a session id obtained from `StartCodeInterpreterSession`. Provide
 * `AgentCore.InvokeCodeInterpreterHttp` on the Function effect to implement
 * the binding.
 *
 * ### Executing Code
 * **Example:** Run Python in a Session
 * ```typescript
 * // init
 * const invoke = yield* AgentCore.InvokeCodeInterpreter(interpreter);
 *
 * // runtime (inside the handler, with an open session)
 * const result = yield* invoke({
 *   sessionId: session.sessionId,
 *   name: "executeCode",
 *   arguments: { language: "python", code: "print(21 * 2)" },
 * });
 * const chunks = yield* Stream.runCollect(result.stream);
 * ```
 *
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

export const InvokeCodeInterpreterHttp = Layer.effect(
  InvokeCodeInterpreter,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.InvokeCodeInterpreter",
    operation: agentcore.invokeCodeInterpreter,
    actions: ["bedrock-agentcore:InvokeCodeInterpreter"],
    requestKey: "codeInterpreterIdentifier",
    identifier: (codeInterpreter: CodeInterpreter) => codeInterpreter.codeInterpreterId,
    arns: (codeInterpreter: CodeInterpreter) => [codeInterpreter.codeInterpreterArn],
  }),
);
