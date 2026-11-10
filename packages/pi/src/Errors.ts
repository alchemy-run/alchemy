import * as Data from "effect/Data";

/**
 * A Pi Durable operation failed: the harness, a conversation, a submission,
 * or the storage under them. `message` is Pi's own text.
 */
export class PiError extends Data.TaggedError("PiError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A tool, model or extension named in a call is not on this harness. */
export class NotOnHarness extends Data.TaggedError("NotOnHarness")<{
  readonly kind: "tool" | "model" | "extension";
  /** The name the call used. */
  readonly missing: string;
}> {}

/** No conversation has this name on this harness instance. */
export class ConversationNotFound extends Data.TaggedError("ConversationNotFound")<{
  readonly conversationName: string;
}> {}
