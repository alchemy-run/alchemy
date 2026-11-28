import * as Redacted from "effect/Redacted";

/**
 * A secret the distilled SDK returns. Older SDK versions return a plain
 * string; versions that mark secrets with the shared name rule return
 * `Redacted`. These helpers accept both.
 */
export type SdkSecret = string | Redacted.Redacted<string>;

/** The secret as `Redacted`, whichever form the SDK returned. */
export const toRedacted = (value: SdkSecret): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

/** The secret's plain value, for an attribute or a comparison that holds a string. */
export const reveal = (value: SdkSecret): string =>
  typeof value === "string" ? value : Redacted.value(value);

/** {@link reveal} that keeps `undefined` and `null` as `undefined`. */
export const revealOptional = (value: SdkSecret | null | undefined): string | undefined =>
  value === undefined || value === null ? undefined : reveal(value);
