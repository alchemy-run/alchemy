/**
 * Blob pathname scheme for the Vercel state store (DESIGN §13).
 *
 * One JSON blob per state row, addressed by URI-encoded segments so that
 * stack/stage/fqn values containing `/` (FQNs always do) or other
 * separator characters can never collide with the scheme's own
 * delimiters:
 *
 * ```
 * r/{stackEnc}/{stageEnc}/{fqnEnc}@{rev}   resource rows (revisioned)
 * o/{stackEnc}/{stageEnc}@{rev}            stack outputs (revisioned)
 * s/{stackEnc}                             stack index (listStacks)
 * ```
 *
 * **Rows are immutable**: every write lands at a NEW `@{rev}` pathname
 * and readers resolve the family's latest revision through a prefix
 * LIST. Vercel Blob's content GETs are only eventually consistent when
 * a pathname is overwritten or delete-then-recreated (live-measured:
 * stale reads and cached 404s for many seconds — the StateStoreCycles
 * chain caught this), while prefix LISTs and never-overwritten
 * pathnames are read-after-write consistent (live-verified,
 * processes/Vercel/PROBES.md). Revisioning therefore restores
 * read-after-write for the store: LIST finds the newest revision, whose
 * content URL has never been overwritten. Superseded revisions (and
 * legacy unrevisioned rows from a v1 store) are pruned best-effort
 * after each write; readers always take the lexicographic max, so a
 * failed prune costs storage, never correctness.
 *
 * The `@` delimiter is unambiguous because every dynamic segment is
 * URI-encoded (`@` → `%40`). Revision tokens are fixed-width
 * zero-padded millis plus a random tiebreaker, so lexicographic order
 * is timestamp order.
 *
 * `listStacks` / `listStages` / `list` are prefix lists over these
 * paths.
 *
 * Kept as a leaf module (pure functions, zero imports) so both the
 * deployed state Function and credential-free unit tests share the
 * exact same scheme.
 */

const enc = encodeURIComponent;
const dec = decodeURIComponent;

/** Prefix for resource rows. */
export const ROW_PREFIX = "r/";

/** Prefix for stack-output rows. */
export const OUTPUT_PREFIX = "o/";

/** Prefix for stack-index rows. */
export const STACK_INDEX_PREFIX = "s/";

/** Pathname of a single resource row. */
export const rowKey = (stack: string, stage: string, fqn: string): string =>
  `${ROW_PREFIX}${enc(stack)}/${enc(stage)}/${enc(fqn)}`;

/** Prefix matching every resource row in one `(stack, stage)`. */
export const stagePrefix = (stack: string, stage: string): string =>
  `${ROW_PREFIX}${enc(stack)}/${enc(stage)}/`;

/** Prefix matching every resource row in a stack (all stages). */
export const stackRowsPrefix = (stack: string): string =>
  `${ROW_PREFIX}${enc(stack)}/`;

/** Pathname of the stack-output row for `(stack, stage)`. */
export const outputKey = (stack: string, stage: string): string =>
  `${OUTPUT_PREFIX}${enc(stack)}/${enc(stage)}`;

/** Prefix matching every stack-output row of a stack. */
export const stackOutputsPrefix = (stack: string): string =>
  `${OUTPUT_PREFIX}${enc(stack)}/`;

/** Pathname of the stack-index row. */
export const stackIndexKey = (stack: string): string =>
  `${STACK_INDEX_PREFIX}${enc(stack)}`;

/**
 * Revision delimiter. Every dynamic segment is URI-encoded (`@` →
 * `%40`), so a literal `@` in a pathname always marks the revision
 * suffix.
 */
export const REV_DELIMITER = "@";

/**
 * A sortable revision token: fixed-width zero-padded epoch millis plus
 * a caller-supplied random tiebreaker, so lexicographic order is
 * timestamp order (ties broken arbitrarily but deterministically).
 */
export const revisionToken = (epochMillis: number, random: string): string =>
  `${String(epochMillis).padStart(14, "0")}-${random}`;

/** Pathname of one immutable revision of a row family. */
export const revisionedKey = (base: string, rev: string): string =>
  `${base}${REV_DELIMITER}${rev}`;

/** The family base of a (possibly revisioned) pathname. */
export const familyBaseOf = (pathname: string): string => {
  const at = pathname.indexOf(REV_DELIMITER);
  return at === -1 ? pathname : pathname.slice(0, at);
};

/** Does `pathname` belong to `base`'s family (legacy base or a revision)? */
export const isFamilyMember = (base: string, pathname: string): boolean =>
  pathname === base || pathname.startsWith(base + REV_DELIMITER);

/**
 * Pick the pathname holding the family's current content: the highest
 * revision, else the legacy unrevisioned base, else `undefined`.
 */
export const latestOfFamily = (
  base: string,
  family: readonly string[],
): string | undefined => {
  let latest: string | undefined;
  let hasLegacy = false;
  for (const pathname of family) {
    if (!isFamilyMember(base, pathname)) continue;
    if (pathname === base) {
      hasLegacy = true;
    } else if (latest === undefined || pathname > latest) {
      latest = pathname;
    }
  }
  return latest ?? (hasLegacy ? base : undefined);
};

/**
 * Group pathnames into row families and pick each family's latest
 * revision (legacy base rows lose to any revision).
 */
export const pickLatestPerFamily = (pathnames: readonly string[]): string[] => {
  const byBase = new Map<string, string[]>();
  for (const pathname of pathnames) {
    const base = familyBaseOf(pathname);
    const family = byBase.get(base);
    if (family === undefined) byBase.set(base, [pathname]);
    else family.push(pathname);
  }
  const latest: string[] = [];
  for (const [base, family] of byBase) {
    const pick = latestOfFamily(base, family);
    if (pick !== undefined) latest.push(pick);
  }
  return latest;
};

/**
 * Parse a resource-row pathname back into its decoded
 * `(stack, stage, fqn)` tuple; `undefined` for foreign pathnames.
 * Revision suffixes are stripped, so every revision of one row parses
 * to the same tuple.
 */
export const parseRowKey = (
  pathname: string,
): { stack: string; stage: string; fqn: string } | undefined => {
  if (!pathname.startsWith(ROW_PREFIX)) return undefined;
  const parts = familyBaseOf(pathname).slice(ROW_PREFIX.length).split("/");
  if (parts.length !== 3) return undefined;
  const [stack, stage, fqn] = parts;
  if (stack === "" || stage === "" || fqn === "") return undefined;
  return { stack: dec(stack!), stage: dec(stage!), fqn: dec(fqn!) };
};

/** Parse a stack-index pathname back into the decoded stack name. */
export const parseStackIndexKey = (pathname: string): string | undefined =>
  pathname.startsWith(STACK_INDEX_PREFIX) &&
  pathname.length > STACK_INDEX_PREFIX.length &&
  !pathname.slice(STACK_INDEX_PREFIX.length).includes("/")
    ? dec(pathname.slice(STACK_INDEX_PREFIX.length))
    : undefined;
