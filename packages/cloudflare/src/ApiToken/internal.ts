import * as Redacted from "effect/Redacted";

// Offset pagination can return the same token on two pages when the list
// shifts between fetches; keep the first occurrence of each id.
export const uniqueTokens = <T extends { id?: string | null }>(tokens: ReadonlyArray<T>): T[] => {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    if (!token.id) return true;
    if (seen.has(token.id)) return false;
    seen.add(token.id);
    return true;
  });
};

/**
 * A created token's value as `Redacted`. Distilled marks it sensitive, so
 * newer versions already return it `Redacted`; older ones return a string.
 */
export const redactTokenValue = (
  value: string | Redacted.Redacted<string>,
): Redacted.Redacted<string> => (Redacted.isRedacted(value) ? value : Redacted.make(value));
