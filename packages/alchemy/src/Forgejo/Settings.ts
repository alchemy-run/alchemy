/**
 * Observed-versus-desired comparison shared by the Forgejo reconcilers.
 *
 * Not exported from `index.ts` — this is internal scaffolding, not part of
 * the provider's public surface.
 */

const sameArray = (
  observed: readonly unknown[],
  desired: readonly unknown[],
): boolean => {
  if (observed.length !== desired.length) return false;
  // Order is not meaningful for any of the lists Forgejo accepts here
  // (permission units, status-check contexts, push whitelists, topics), so
  // compare them as sets rather than sequences.
  const left = [...observed].map(String).sort();
  const right = [...desired].map(String).sort();
  return left.every((value, index) => value === right[index]);
};

/**
 * Whether the live resource already satisfies every managed setting.
 *
 * A `undefined` entry in `desired` means the prop was omitted, which leaves
 * that setting unmanaged rather than resetting it — so it is skipped. Every
 * other entry must equal what was observed, otherwise the caller issues its
 * update call.
 *
 * Skipping a matching update is not just an optimization: Forgejo rejects
 * edits to an archived repository, so re-sending an unchanged payload on
 * every deploy would make `archived: true` a permanent deploy failure.
 */
export const matchesDesired = (
  observed: unknown,
  desired: Readonly<Record<string, unknown>>,
): boolean => {
  const live = observed as Record<string, unknown>;
  return Object.entries(desired).every(([key, value]) => {
    if (value === undefined) return true;
    const current = live[key];
    if (Array.isArray(value)) {
      return Array.isArray(current) && sameArray(current, value);
    }
    return current === value;
  });
};
