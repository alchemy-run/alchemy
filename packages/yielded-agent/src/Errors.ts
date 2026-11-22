import * as Data from "effect/Data";

/** The harness could not do what was asked of it: its history is unavailable, or a run named a tool or model it was not given. */
export class YieldedAgentError extends Data.TaggedError("YieldedAgentError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
