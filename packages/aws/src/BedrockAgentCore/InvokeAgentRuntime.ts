import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Runtime } from "./Runtime.ts";

export interface InvokeAgentRuntimeRequest extends Omit<
  agentcore.InvokeAgentRuntimeRequest,
  "agentRuntimeArn"
> {}

/**
 * Sends a request to an agent hosted in an AgentCore Runtime and receives
 * the (optionally streaming) response.
 *
 * Bind a {@link Runtime} inside a function runtime to invoke the hosted
 * agent with session isolation (requests with the same `runtimeSessionId`
 * land on the same sandbox). Provide `AgentCore.InvokeAgentRuntimeHttp` on
 * the Function effect to implement the binding.
 *
 * ### Invoking an Agent
 * **Example:** Invoke a Hosted Agent
 * ```typescript
 * // init
 * const invoke = yield* AgentCore.InvokeAgentRuntime(runtime);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const response = yield* invoke({
 *       runtimeSessionId: "session-0000000000000000000000000000000001",
 *       payload: JSON.stringify({ prompt: "hello" }),
 *     });
 *     return HttpServerResponse.json({ contentType: response.contentType });
 *   }),
 * };
 * ```
 *
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
    ) => Effect.Effect<agentcore.InvokeAgentRuntimeResponse, agentcore.InvokeAgentRuntimeError>
  >
> {}
export const InvokeAgentRuntime = Binding.Service<InvokeAgentRuntime>(
  "AWS.BedrockAgentCore.InvokeAgentRuntime",
);

export const InvokeAgentRuntimeHttp = Layer.effect(
  InvokeAgentRuntime,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.InvokeAgentRuntime",
    operation: agentcore.invokeAgentRuntime,
    actions: ["bedrock-agentcore:InvokeAgentRuntime"],
    requestKey: "agentRuntimeArn",
    identifier: (runtime: Runtime) => runtime.agentRuntimeArn,
    arns: (runtime: Runtime) => [
      runtime.agentRuntimeArn,
      // qualified invocations target a runtime endpoint sub-resource.
      Output.interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`,
    ],
  }),
);
