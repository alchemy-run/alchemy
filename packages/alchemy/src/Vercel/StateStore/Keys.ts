/**
 * Blob pathname scheme for the Vercel state store (DESIGN §13).
 *
 * One JSON blob per state row, addressed by URI-encoded segments so that
 * stack/stage/fqn values containing `/` (FQNs always do) or other
 * separator characters can never collide with the scheme's own
 * delimiters:
 *
 * ```
 * r/{stackEnc}/{stageEnc}/{fqnEnc}   resource rows
 * o/{stackEnc}/{stageEnc}            stack outputs
 * s/{stackEnc}                       stack index (listStacks)
 * ```
 *
 * `listStacks` / `listStages` / `list` are prefix lists over these
 * paths (the Blob data plane's `prefix` listing is immediately
 * consistent — live-verified, see processes/Vercel/PROBES.md).
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
 * Parse a resource-row pathname back into its decoded
 * `(stack, stage, fqn)` tuple; `undefined` for foreign pathnames.
 */
export const parseRowKey = (
  pathname: string,
): { stack: string; stage: string; fqn: string } | undefined => {
  if (!pathname.startsWith(ROW_PREFIX)) return undefined;
  const parts = pathname.slice(ROW_PREFIX.length).split("/");
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
