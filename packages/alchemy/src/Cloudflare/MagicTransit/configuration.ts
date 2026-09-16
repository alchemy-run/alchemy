import * as Redacted from "effect/Redacted";
import { deepEqual } from "../../Diff.ts";

/** Compare optional API structures without treating response nulls as values. */
export const sameConfiguration = (left: unknown, right: unknown): boolean =>
  deepEqual(normalize(left), normalize(right));

const normalize = (value: unknown): unknown => {
  if (value == null) return undefined;
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, normalize(value)]),
    );
  return value;
};

/** A omitted optional configuration needs recreation when the API cannot clear it. */
export const removedConfiguration = (
  previous: unknown,
  desired: unknown,
): boolean => {
  if (previous == null) return false;
  if (desired === undefined) return true;
  if (
    typeof previous !== "object" ||
    typeof desired !== "object" ||
    desired === null ||
    Array.isArray(previous) ||
    Array.isArray(desired) ||
    Redacted.isRedacted(previous) ||
    Redacted.isRedacted(desired)
  )
    return false;
  const next = desired as Record<string, unknown>;
  return Object.entries(previous).some(([key, value]) =>
    removedConfiguration(value, next[key]),
  );
};
