/**
 * True when every value `desired` sets is present in `actual`. Arrays must
 * have the same length and match element by element. Keys `desired` leaves
 * undefined are not compared, so defaults Mux fills in do not count as drift.
 */
export const matches = (desired: unknown, actual: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((d, i) => matches(d, actual[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matches(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return desired === actual;
};

/**
 * The `meta` object to send so Mux ends up holding exactly `want`, or
 * undefined if it already does. Mux ignores `{}`; a key is cleared by
 * sending it as an empty string.
 */
export const metaWrite = (
  want: Record<string, string | undefined> | undefined,
  have: Record<string, string | undefined> | undefined,
) => {
  const keys = [...new Set([...Object.keys(want ?? {}), ...Object.keys(have ?? {})])];
  const body = Object.fromEntries(keys.map((key) => [key, want?.[key] ?? ""]));
  return keys.some((key) => body[key] !== (have?.[key] ?? "")) ? body : undefined;
};
