import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface ListEventsRequest extends Omit<
  agentcore.ListEventsInput,
  "memoryId"
> {}

/**
 * Lists the events of an actor's session in a memory's short-term store.
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
export const ListEvents = Binding.Service<ListEvents>(
  "AWS.BedrockAgentCore.ListEvents",
);
