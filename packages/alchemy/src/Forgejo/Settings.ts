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
 * Skipping a matching update keeps a converged resource quiet: a no-op `PATCH`
 * still counts as a write, bumping the resource's timestamps and reporting an
 * update on a deploy that had nothing to do. It is not a guard against
 * archived repositories — contrary to what Gitea's model suggests, Forgejo
 * 16.0.3 accepts and applies a `PATCH` to a repository with `archived: true`.
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
