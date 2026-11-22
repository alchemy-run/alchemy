import * as Data from "effect/Data";

/**
 * An OpenCode operation failed: its sandbox, the OpenCode server in it, or
 * a request to that server. `message` is OpenCode's or the platform's own
 * text.
 */
export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A tool or model named in a call is not on this harness. */
export class NotOnHarness extends Data.TaggedError("NotOnHarness")<{
  readonly kind: "tool" | "model";
  /** The name the call used. */
  readonly missing: string;
}> {}
