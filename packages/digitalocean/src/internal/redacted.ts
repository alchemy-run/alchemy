import * as Redacted from "effect/Redacted";

/** A secret the SDK returns as a string or already redacted. */
export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

export const toRedactedOrUndefined = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined => (value === undefined ? undefined : toRedacted(value));
