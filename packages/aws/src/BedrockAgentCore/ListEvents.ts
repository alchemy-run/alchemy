import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Memory } from "./Memory.ts";

export interface ListEventsRequest extends Omit<agentcore.ListEventsInput, "memoryId"> {}

/**
 * Lists the events of an actor's session in a memory's short-term store.
 *
 * Bind a {@link Memory} inside a function runtime to page through the raw
 * events recorded with `CreateEvent`. Provide `AgentCore.ListEventsHttp` on
 * the Function effect to implement the binding.
 *
 * ### Listing Events
 * **Example:** List a Session's Events
 * ```typescript
 * // init
 * const listEvents = yield* AgentCore.ListEvents(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listEvents({
 *       actorId: "user-1",
 *       sessionId: "session-1",
 *     });
 *     return HttpServerResponse.json({ count: result.events.length });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface ListEvents extends Binding.Service<
  ListEvents,
  "AWS.BedrockAgentCore.ListEvents",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListEventsRequest,
    ) => Effect.Effect<agentcore.ListEventsOutput, agentcore.ListEventsError>
  >
> {}
export const ListEvents = Binding.Service<ListEvents>("AWS.BedrockAgentCore.ListEvents");

export const ListEventsHttp = Layer.effect(
  ListEvents,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListEvents",
    operation: agentcore.listEvents,
    actions: ["bedrock-agentcore:ListEvents"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
