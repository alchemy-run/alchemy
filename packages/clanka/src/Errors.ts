import * as Data from "effect/Data";

/** The harness could not do what was asked of it: its store or sandbox is unavailable, or a prompt named a model it was not given. */
export class ClankaError extends Data.TaggedError("ClankaError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
