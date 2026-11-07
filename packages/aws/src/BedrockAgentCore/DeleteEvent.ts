import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Memory } from "./Memory.ts";

export interface DeleteEventRequest extends Omit<agentcore.DeleteEventInput, "memoryId"> {}

/**
 * Deletes a short-term event from an actor's session.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.DeleteEventHttp`
 * on the Function effect to implement the binding.
 *
 * ### Deleting Events
 * **Example:** Delete an Event by Id
 * ```typescript
 * // init
 * const deleteEvent = yield* AgentCore.DeleteEvent(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* deleteEvent({
 *       actorId: "user-1",
 *       sessionId: "session-1",
 *       eventId,
 *     });
 *     return HttpServerResponse.json({ deleted: true });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface DeleteEvent extends Binding.Service<
  DeleteEvent,
  "AWS.BedrockAgentCore.DeleteEvent",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: DeleteEventRequest,
    ) => Effect.Effect<agentcore.DeleteEventOutput, agentcore.DeleteEventError>
  >
> {}
export const DeleteEvent = Binding.Service<DeleteEvent>("AWS.BedrockAgentCore.DeleteEvent");

export const DeleteEventHttp = Layer.effect(
  DeleteEvent,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.DeleteEvent",
    operation: agentcore.deleteEvent,
    actions: ["bedrock-agentcore:DeleteEvent"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
