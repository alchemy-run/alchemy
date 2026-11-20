import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Memory } from "./Memory.ts";

export interface BatchUpdateMemoryRecordsRequest extends Omit<
  agentcore.BatchUpdateMemoryRecordsInput,
  "memoryId"
> {}

/**
 * Updates long-term memory records in bulk.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.BatchUpdateMemoryRecordsHttp`
 * on the Function effect to implement the binding.
 *
 * ### Writing Memory Records
 * **Example:** Update a Record's Content
 * ```typescript
 * // init
 * const batchUpdateMemoryRecords = yield* AgentCore.BatchUpdateMemoryRecords(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* batchUpdateMemoryRecords({
 *       records: [
 *         {
 *           memoryRecordId,
 *           timestamp: new Date(),
 *           content: { text: "The user's favorite color is green." },
 *           namespaces: ["facts/user-1"],
 *         },
 *       ],
 *     });
 *     return HttpServerResponse.json({
 *       updated: result.successfulRecords.length,
 *     });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface BatchUpdateMemoryRecords extends Binding.Service<
  BatchUpdateMemoryRecords,
  "AWS.BedrockAgentCore.BatchUpdateMemoryRecords",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: BatchUpdateMemoryRecordsRequest,
    ) => Effect.Effect<
      agentcore.BatchUpdateMemoryRecordsOutput,
      agentcore.BatchUpdateMemoryRecordsError
    >
  >
> {}
export const BatchUpdateMemoryRecords = Binding.Service<BatchUpdateMemoryRecords>(
  "AWS.BedrockAgentCore.BatchUpdateMemoryRecords",
);

export const BatchUpdateMemoryRecordsHttp = Layer.effect(
  BatchUpdateMemoryRecords,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.BatchUpdateMemoryRecords",
    operation: agentcore.batchUpdateMemoryRecords,
    actions: ["bedrock-agentcore:BatchUpdateMemoryRecords"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
