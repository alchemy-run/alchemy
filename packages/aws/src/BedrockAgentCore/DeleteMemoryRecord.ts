import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Memory } from "./Memory.ts";

export interface DeleteMemoryRecordRequest extends Omit<
  agentcore.DeleteMemoryRecordInput,
  "memoryId"
> {}

/**
 * Deletes a long-term memory record.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.DeleteMemoryRecordHttp`
 * on the Function effect to implement the binding.
 *
 * ### Deleting Memory Records
 * **Example:** Delete a Record by Id
 * ```typescript
 * // init
 * const deleteMemoryRecord = yield* AgentCore.DeleteMemoryRecord(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* deleteMemoryRecord({ memoryRecordId });
 *     return HttpServerResponse.json({ deleted: true });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface DeleteMemoryRecord extends Binding.Service<
  DeleteMemoryRecord,
  "AWS.BedrockAgentCore.DeleteMemoryRecord",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: DeleteMemoryRecordRequest,
    ) => Effect.Effect<agentcore.DeleteMemoryRecordOutput, agentcore.DeleteMemoryRecordError>
  >
> {}
export const DeleteMemoryRecord = Binding.Service<DeleteMemoryRecord>(
  "AWS.BedrockAgentCore.DeleteMemoryRecord",
);

export const DeleteMemoryRecordHttp = Layer.effect(
  DeleteMemoryRecord,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.DeleteMemoryRecord",
    operation: agentcore.deleteMemoryRecord,
    actions: ["bedrock-agentcore:DeleteMemoryRecord"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
