import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface RetrieveMemoryRecordsRequest extends Omit<
  agentcore.RetrieveMemoryRecordsInput,
  "memoryId"
> {}

/**
 * Semantically searches extracted long-term memory records.
 * @binding
 */
export interface RetrieveMemoryRecords extends Binding.Service<
  RetrieveMemoryRecords,
  "AWS.BedrockAgentCore.RetrieveMemoryRecords",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: RetrieveMemoryRecordsRequest,
    ) => Effect.Effect<
      agentcore.RetrieveMemoryRecordsOutput,
      agentcore.RetrieveMemoryRecordsError
    >
  >
> {}
export const RetrieveMemoryRecords = Binding.Service<RetrieveMemoryRecords>(
  "AWS.BedrockAgentCore.RetrieveMemoryRecords",
);
