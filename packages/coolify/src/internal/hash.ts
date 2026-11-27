import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const canonical = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

/**
 * sha256 of a value's canonical JSON (sorted keys, `Redacted` unwrapped).
 * Stored in attributes instead of secret values, so a changed secret still
 * changes the hash without the secret entering state.
 */
export const hashOf = (value: unknown) =>
  Effect.sync(() =>
    createHash("sha256")
      .update(JSON.stringify(canonical(value)))
      .digest("hex"),
  );
