import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Runtime } from "./Runtime.ts";

export interface GetAgentCardRequest extends Omit<
  agentcore.GetAgentCardRequest,
  "agentRuntimeArn"
> {}

/**
 * Fetches the A2A agent card describing the agent runtime's capabilities.
 *
 * Bind a {@link Runtime} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.GetAgentCardHttp`
 * on the Function effect to implement the binding.
 *
 * ### Agent Discovery
 * **Example:** Fetch the Agent Card
 * ```typescript
 * // init
 * const getAgentCard = yield* AgentCore.GetAgentCard(runtime);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* getAgentCard({});
 *     return HttpServerResponse.json({ card: result.agentCard });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface GetAgentCard extends Binding.Service<
  GetAgentCard,
  "AWS.BedrockAgentCore.GetAgentCard",
  <R extends Runtime>(
    runtime: R,
  ) => Effect.Effect<
    (
      request: GetAgentCardRequest,
    ) => Effect.Effect<agentcore.GetAgentCardResponse, agentcore.GetAgentCardError>
  >
> {}
export const GetAgentCard = Binding.Service<GetAgentCard>("AWS.BedrockAgentCore.GetAgentCard");

export const GetAgentCardHttp = Layer.effect(
  GetAgentCard,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.GetAgentCard",
    operation: agentcore.getAgentCard,
    actions: ["bedrock-agentcore:GetAgentCard"],
    requestKey: "agentRuntimeArn",
    identifier: (runtime: Runtime) => runtime.agentRuntimeArn,
    arns: (runtime: Runtime) => [
      runtime.agentRuntimeArn,
      // qualified invocations target a runtime endpoint sub-resource.
      Output.interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`,
    ],
  }),
);
