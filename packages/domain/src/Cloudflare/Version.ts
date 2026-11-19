import * as Context from "effect/Context";

/**
 * The version of how Domain models lay out their Durable Objects on
 * Cloudflare. Version 1 keeps every object of a model in one class,
 * `Billing.Domain`, named `Billing.AccountAggregate/a-1`; a deploy moves each
 * object of a version 0 class (`Billing.AccountAggregate`) into it, then
 * deletes the old class (see `Migration.ts`). Before version 0, a class was
 * named after its definition alone (`AccountAggregate`), and a deploy renames
 * it to its version 0 name with `renamedFrom` first.
 */
export const DOMAIN_VERSION = 1;

/**
 * The Domain version a Worker's models are laid out with: always
 * {@link DOMAIN_VERSION}. Tests set an earlier one (`undefined` for the layout
 * from before versions existed), and check that the next deploy carries it over.
 *
 * @internal
 */
export const DeployVersion = Context.Reference<number | undefined>("alchemy/Domain/DeployVersion", {
  defaultValue: () => DOMAIN_VERSION,
});

/** The Workflow that moves a model's objects out of its old classes during a deploy. */
export const MIGRATION_WORKFLOW = "AlchemyDomainMigration";

/**
 * How far apart two passes over an old class must be before it may be
 * deleted. Cloudflare lists a Durable Object a few minutes after it is first
 * written: until then, a pass over an old class's listed objects may miss some.
 */
export const LISTING_LAG_SECONDS = 15 * 60;

/** A short, stable hash of `text`, for Workflow instance ids. */
export const fnv = (text: string) => {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * The migration Workflow instance that records a complete pass over an old
 * class: every object Cloudflare listed at `listedAt` (seconds) has moved.
 * Cloudflare keeps the instance, so the next upload can read it. It names the
 * class's namespace too: a Worker deleted and deployed again has new
 * namespaces, so passes recorded for the old ones never count.
 */
export const passMarker = (className: string, namespaceId: string, listedAt: number) =>
  `moved-${fnv(`${className}|${namespaceId}`)}-${listedAt}`;

/** When each complete pass over `className` listed its objects, from the Workflow's instance ids. */
export const passesOf = (
  className: string,
  namespaceId: string,
  instanceIds: Iterable<string>,
): Array<number> => {
  const prefix = `moved-${fnv(`${className}|${namespaceId}`)}-`;
  const passes: Array<number> = [];
  for (const id of instanceIds) {
    if (!id.startsWith(prefix)) continue;
    const at = Number(id.slice(prefix.length));
    if (Number.isInteger(at)) passes.push(at);
  }
  return passes;
};

/**
 * The id of a complete pass over `className` that left only `count` objects it
 * can't move (they know neither their name nor their key). Nothing writes to an
 * old class after the upgrade, so once two such passes far enough apart saw the
 * same count, a later pass would find nothing new: deploys skip it.
 */
export const unmovableMarker = (
  className: string,
  namespaceId: string,
  count: number,
  listedAt: number,
) => `unmovable-${fnv(`${className}|${namespaceId}`)}-${count}-${listedAt}`;

/**
 * Whether every pass over `className` would find only the `count` objects it
 * can't move: two passes {@link LISTING_LAG_SECONDS} apart left that many.
 */
export const onlyUnmovableLeft = (
  className: string,
  namespaceId: string,
  count: number,
  instanceIds: Iterable<string>,
) => {
  const prefix = `unmovable-${fnv(`${className}|${namespaceId}`)}-${count}-`;
  const times: Array<number> = [];
  for (const id of instanceIds) {
    if (!id.startsWith(prefix)) continue;
    const at = Number(id.slice(prefix.length));
    if (Number.isInteger(at)) times.push(at);
  }
  return times.length > 1 && Math.max(...times) - Math.min(...times) >= LISTING_LAG_SECONDS;
};

/**
 * The version 0 classes an upload keeps live, to move their objects to the
 * shared class. A class is kept while the Worker has it, until it has two
 * complete passes at least {@link LISTING_LAG_SECONDS} apart. The first pass
 * runs after the upload that started the move, and nothing writes to the old
 * class after that upload; by the later pass, Cloudflare lists every object
 * written before it, so that pass moved them all. The others are left out,
 * and the upload deletes them.
 */
export const keptMovers = ({
  movers,
  deployedClasses,
  namespaces,
  passes,
}: {
  readonly movers: ReadonlyArray<{ readonly className: string }>;
  /** The classes the Worker has now, and the classes this upload renames to. */
  readonly deployedClasses: ReadonlySet<string>;
  /** The Worker's Durable Object namespace ids, by class. */
  readonly namespaces: ReadonlyMap<string, string>;
  /** The migration Workflow's complete instances: see {@link passMarker}. */
  readonly passes: ReadonlyArray<string>;
}) => {
  const kept = new Set<string>();
  for (const mover of movers) {
    if (!deployedClasses.has(mover.className)) continue;
    const namespace = namespaces.get(mover.className);
    const times = namespace === undefined ? [] : passesOf(mover.className, namespace, passes);
    const settled =
      times.length > 0 && Math.max(...times) - Math.min(...times) >= LISTING_LAG_SECONDS;
    if (!settled) kept.add(mover.className);
  }
  return kept;
};
