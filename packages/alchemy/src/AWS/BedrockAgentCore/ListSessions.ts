import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface ListSessionsRequest extends Omit<
  agentcore.ListSessionsInput,
  "memoryId"
> {}

/**
 * Lists an actor's sessions in a memory.
 * @binding
 */
export interface ListSessions extends Binding.Service<
  ListSessions,
  "AWS.BedrockAgentCore.ListSessions",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListSessionsRequest,
    ) => Effect.Effect<
      agentcore.ListSessionsOutput,
      agentcore.ListSessionsError
    >
  >
> {}
export const ListSessions = Binding.Service<ListSessions>(
  "AWS.BedrockAgentCore.ListSessions",
);
