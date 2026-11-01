import { arrayEqualsUnordered } from "alchemy/Util/equal";
import * as Redacted from "effect/Redacted";

/** Whether two string lists hold the same members (order-insensitive; nullish is empty). */
export const sameMembers = (
  a: ReadonlyArray<string> | null | undefined,
  b: ReadonlyArray<string> | null | undefined,
): boolean => arrayEqualsUnordered(a ?? [], b ?? []);

/** A copy of `value` with every `Redacted` replaced by its text. Compare it; never log it. */
const reveal = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(reveal);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reveal(item)]));
  }
  return value;
};

/**
 * Whether two values that may hold `Redacted` secrets differ. A `Redacted`
 * serializes to a fixed marker, so a plain comparison would miss a new secret.
 */
export const secretsDiffer = (a: unknown, b: unknown): boolean =>
  JSON.stringify(reveal(a)) !== JSON.stringify(reveal(b));
