import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * The version of how Domain models lay out their Durable Objects. Bump it by
 * hand with every change that would otherwise lose deployed data, and add the
 * step that carries that data over to {@link migrate}.
 *
 * A Worker records the version it was deployed with in its
 * `alchemy:domain:v<N>` tag. A Worker without the tag was deployed before
 * versions existed: version `undefined`.
 */
export const DOMAIN_VERSION = 1;

/**
 * The Domain version a Worker's models are laid out with: always
 * {@link DOMAIN_VERSION}. Tests set `undefined` to deploy the layout from
 * before versions existed, and check that the next deploy migrates it.
 *
 * @internal
 */
export const DeployVersion = Context.Reference<number | undefined>("alchemy/Domain/DeployVersion", {
  defaultValue: () => DOMAIN_VERSION,
});

/** A Durable Object class a Domain model hosts, as the Worker deploy sees it. */
export interface DomainClass {
  /** The model that hosts the class. */
  readonly model: string;
  /** The class name in this version, e.g. `Billing.AccountAggregate`. */
  readonly className: string;
  /** The class name before Domain version 0, e.g. `AccountAggregate`. */
  readonly legacyName: string;
  /** The model keeps the class's data when models shared it before version 0. */
  readonly legacyData: boolean;
  /**
   * The class is version 0's, kept by version 1 code only to move its objects
   * to the shared class: live while any of them still holds data.
   */
  readonly mover?: boolean;
  /**
   * Set on a class from before Domain version 0 (`className` is then its
   * `legacyName`) that version 1 code keeps live under its own name while its
   * objects move: the model's binding to it. Models that shared the class each
   * bind it; the upload keeps only the binding of the model that keeps its
   * data (see {@link legacyKeepers}).
   */
  readonly binding?: string;
}

/**
 * A model whose old classes the Worker's deploy moves into its class, between
 * its two uploads (see `WorkerProvider`).
 */
export interface DomainMigration {
  readonly model: string;
  /** The model's class, `Billing.Domain`. */
  readonly domainClass: string;
  /** Each old class the code can move, the binding it reaches it by, and the route its objects move to. */
  readonly classes: ReadonlyArray<{
    readonly className: string;
    readonly binding: string;
    readonly route: string;
  }>;
  /** How long the deploy waits for the move, in seconds. */
  readonly timeoutSeconds?: number;
}

/** The binding through which a model reaches its class from before Domain version 0. */
export const beforeVersionsBinding = (className: string) => `${className}.BeforeVersions`;

/**
 * Models in one Worker shared a Durable Object class before Domain version 0,
 * and none, or more than one, was chosen to keep its data.
 */
export class AmbiguousDomainLegacyData extends Data.TaggedError("AmbiguousDomainLegacyData")<{
  readonly scriptName: string;
  readonly legacyName: string;
  readonly models: ReadonlyArray<string>;
}> {
  override get message() {
    return (
      `Models ${this.models.join(", ")} on Worker '${this.scriptName}' shared the Durable Object class '${this.legacyName}' before Domain version 0, so its data belongs to both. ` +
      "Each model now has its own classes, and only one can keep that data. " +
      `Set \`legacyData: true\` in the layer options of exactly one of them, e.g. \`${this.models[0]}.layer(handlers, { legacyData: true })\`; the others start empty.`
    );
  }
}

/**
 * A newer Alchemy deployed this Worker, with a Domain layout this one doesn't
 * know. Deploying would move its data back to an older layout, so the deploy
 * stops before any upload.
 */
export class DomainVersionTooNew extends Data.TaggedError("DomainVersionTooNew")<{
  readonly scriptName: string;
  readonly deployed: number;
  readonly current: number;
}> {
  override get message() {
    return (
      `Worker '${this.scriptName}' was deployed with Domain version ${this.deployed}, but this Alchemy only knows up to version ${this.current}. ` +
      "Deploy it with the Alchemy release that deployed it, or a newer one."
    );
  }
}

/**
 * Fail when a newer Alchemy deployed the Worker. Checked on every deploy of a
 * Worker, whether or not it still hosts a model: older code would move the
 * newer layout's data back, or delete its classes.
 */
export const refuseDowngrade = ({
  scriptName,
  deployed,
}: {
  readonly scriptName: string;
  readonly deployed: number | undefined;
}) =>
  deployed !== undefined && deployed > DOMAIN_VERSION
    ? Effect.fail(new DomainVersionTooNew({ scriptName, deployed, current: DOMAIN_VERSION }))
    : Effect.void;

/** The tag that records the Domain version a Worker was deployed with. */
export const versionTag = (version: number) => `alchemy:domain:v${version}`;

/** The Domain version a Worker was deployed with, from its tags; `undefined` before versions existed. */
export const deployedVersion = (tags: ReadonlyArray<string>): number | undefined => {
  for (const tag of tags) {
    const match = /^alchemy:domain:v(\d+)$/.exec(tag);
    if (match) return Number(match[1]);
  }
  return undefined;
};

/** The Workflow, on a Domain's Worker, that moves version 0 objects to the shared class. */
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
  readonly movers: ReadonlyArray<DomainClass>;
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

/**
 * The model that keeps each class from before Domain version 0 that the
 * Worker still has: the only model that hosts it, or the one of those that
 * shared it with `legacyData` set.
 */
export const legacyKeepers = Effect.fn(function* ({
  scriptName,
  classes,
  deployedClasses,
}: {
  readonly scriptName: string;
  readonly classes: ReadonlyArray<DomainClass>;
  readonly deployedClasses: ReadonlySet<string>;
}) {
  const byLegacyName = new Map<string, Array<DomainClass>>();
  for (const domainClass of classes) {
    if (!deployedClasses.has(domainClass.legacyName)) continue;
    const sharing = byLegacyName.get(domainClass.legacyName) ?? [];
    sharing.push(domainClass);
    byLegacyName.set(domainClass.legacyName, sharing);
  }
  const keepers = new Map<string, DomainClass>();
  for (const [legacyName, sharing] of byLegacyName) {
    const keeps =
      sharing.length === 1 ? sharing : sharing.filter((domainClass) => domainClass.legacyData);
    if (keeps.length !== 1) {
      return yield* new AmbiguousDomainLegacyData({
        scriptName,
        legacyName,
        models: sharing.map((domainClass) => domainClass.model),
      });
    }
    keepers.set(legacyName, keeps[0]!);
  }
  return keepers;
});

/**
 * How a Worker deployed at `deployed` reaches {@link DOMAIN_VERSION} without
 * losing data. `deployedClasses` are the classes the Worker hosts now.
 *
 * - `renamed`: Durable Object class renames in this upload. Version 0 code
 *   renames the classes from before versions (`AccountAggregate`) after their
 *   model (`Billing.AccountAggregate`).
 * - `kept`: classes from before versions that version 1 code keeps under
 *   their own names, by the binding of the model that keeps each, while their
 *   objects move to the shared class. Nothing is renamed: a rename lists its
 *   class twice in the upload's exports, and a large Worker would pass
 *   Cloudflare's limit of 100.
 */
export const migrate = Effect.fn(function* ({
  scriptName,
  deployed,
  classes,
  deployedClasses,
}: {
  readonly scriptName: string;
  readonly deployed: number | undefined;
  readonly classes: ReadonlyArray<DomainClass>;
  readonly deployedClasses: ReadonlySet<string>;
}) {
  const renamed: Array<{ readonly from: string; readonly to: string }> = [];
  const kept: Array<{ readonly className: string; readonly binding: string }> = [];
  if (deployed !== undefined) return { renamed, kept };
  // Version 1 code binds each class from before versions itself.
  const beforeVersions = classes.filter((domainClass) => domainClass.binding !== undefined);
  if (beforeVersions.length > 0) {
    const keepers = yield* legacyKeepers({ scriptName, classes: beforeVersions, deployedClasses });
    for (const [className, keeper] of keepers) kept.push({ className, binding: keeper.binding! });
    return { renamed, kept };
  }
  // none -> 0: classes were named after the definition (`AccountAggregate`),
  // now after the model too (`Billing.AccountAggregate`).
  const keepers = yield* legacyKeepers({ scriptName, classes, deployedClasses });
  for (const [legacyName, keeper] of keepers)
    renamed.push({ from: legacyName, to: keeper.className });
  // 0 -> 1: nothing is renamed. The version 0 classes stay live next to the
  // shared class while their objects move (see `keptMovers`).
  return { renamed, kept };
});
