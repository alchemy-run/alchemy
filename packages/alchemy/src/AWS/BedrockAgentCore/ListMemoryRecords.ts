import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface ListMemoryRecordsRequest extends Omit<
  agentcore.ListMemoryRecordsInput,
  "memoryId"
> {}

/**
 * Lists extracted long-term memory records in a namespace.
 * @binding
 */
export interface ListMemoryRecords extends Binding.Service<
  ListMemoryRecords,
  "AWS.BedrockAgentCore.ListMemoryRecords",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListMemoryRecordsRequest,
    ) => Effect.Effect<
      agentcore.ListMemoryRecordsOutput,
      agentcore.ListMemoryRecordsError
    >
  >
> {}
export const ListMemoryRecords = Binding.Service<ListMemoryRecords>(
  "AWS.BedrockAgentCore.ListMemoryRecords",
);
