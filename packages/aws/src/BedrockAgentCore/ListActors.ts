import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Memory } from "./Memory.ts";

export interface ListActorsRequest extends Omit<agentcore.ListActorsInput, "memoryId"> {}

/**
 * Lists the actors that have recorded events in the memory.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.ListActorsHttp`
 * on the Function effect to implement the binding.
 *
 * ### Listing Actors
 * **Example:** List Actors
 * ```typescript
 * // init
 * const listActors = yield* AgentCore.ListActors(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listActors({});
 *     return HttpServerResponse.json({
 *       count: result.actorSummaries.length,
 *     });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface ListActors extends Binding.Service<
  ListActors,
  "AWS.BedrockAgentCore.ListActors",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListActorsRequest,
    ) => Effect.Effect<agentcore.ListActorsOutput, agentcore.ListActorsError>
  >
> {}
export const ListActors = Binding.Service<ListActors>("AWS.BedrockAgentCore.ListActors");

export const ListActorsHttp = Layer.effect(
  ListActors,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListActors",
    operation: agentcore.listActors,
    actions: ["bedrock-agentcore:ListActors"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
