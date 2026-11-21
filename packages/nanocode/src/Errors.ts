import * as Data from "effect/Data";

/** The harness could not do what was asked of it, or nanocode ended a turn without an answer. */
export class NanocodeError extends Data.TaggedError("NanocodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
