import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Memory } from "./Memory.ts";

export interface BatchDeleteMemoryRecordsRequest extends Omit<
  agentcore.BatchDeleteMemoryRecordsInput,
  "memoryId"
> {}

/**
 * Deletes long-term memory records in bulk.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.BatchDeleteMemoryRecordsHttp`
 * on the Function effect to implement the binding.
 *
 * ### Deleting Memory Records
 * **Example:** Delete Records in Bulk
 * ```typescript
 * // init
 * const batchDeleteMemoryRecords = yield* AgentCore.BatchDeleteMemoryRecords(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* batchDeleteMemoryRecords({
 *       records: [{ memoryRecordId }],
 *     });
 *     return HttpServerResponse.json({
 *       deleted: result.successfulRecords.length,
 *     });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface BatchDeleteMemoryRecords extends Binding.Service<
  BatchDeleteMemoryRecords,
  "AWS.BedrockAgentCore.BatchDeleteMemoryRecords",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: BatchDeleteMemoryRecordsRequest,
    ) => Effect.Effect<
      agentcore.BatchDeleteMemoryRecordsOutput,
      agentcore.BatchDeleteMemoryRecordsError
    >
  >
> {}
export const BatchDeleteMemoryRecords = Binding.Service<BatchDeleteMemoryRecords>(
  "AWS.BedrockAgentCore.BatchDeleteMemoryRecords",
);

export const BatchDeleteMemoryRecordsHttp = Layer.effect(
  BatchDeleteMemoryRecords,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.BatchDeleteMemoryRecords",
    operation: agentcore.batchDeleteMemoryRecords,
    actions: ["bedrock-agentcore:BatchDeleteMemoryRecords"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
