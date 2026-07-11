import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface CreateEventRequest extends Omit<
  agentcore.CreateEventInput,
  "memoryId"
> {}

/**
 * Records an interaction event into a memory's short-term store.
 * @binding
 */
export interface CreateEvent extends Binding.Service<
  CreateEvent,
  "AWS.BedrockAgentCore.CreateEvent",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: CreateEventRequest,
    ) => Effect.Effect<agentcore.CreateEventOutput, agentcore.CreateEventError>
  >
> {}
export const CreateEvent = Binding.Service<CreateEvent>(
  "AWS.BedrockAgentCore.CreateEvent",
);
