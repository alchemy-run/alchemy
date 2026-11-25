import * as Redacted from "effect/Redacted";

/** Distilled decodes Mux secrets as `Redacted`; this also accepts a plain string. */
export const redact = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> =>
  value === undefined
    ? Redacted.make("")
    : Redacted.isRedacted(value)
      ? value
      : Redacted.make(value);
