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
}

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

/** The tag that records when a Worker started moving its objects to the shared class (version 1). */
export const movingTag = (sinceSeconds: number) => `alchemy:domain:moving:${sinceSeconds}`;

/** When a Worker started moving its objects to the shared class, in seconds; `undefined` if it isn't. */
export const movingSince = (tags: ReadonlyArray<string>): number | undefined => {
  for (const tag of tags) {
    const match = /^alchemy:domain:moving:(\d+)$/.exec(tag);
    if (match) return Number(match[1]);
  }
  return undefined;
};

/**
 * How long after the move starts an old class may be deleted. Cloudflare
 * lists a Durable Object a few minutes after it is first written: until then,
 * an old class that lists no objects may still have some.
 */
export const LISTING_LAG_SECONDS = 15 * 60;

/**
 * The version 0 classes an upload keeps live, to move their objects to the
 * shared class. A class is kept while the Worker has it and, once the move
 * has been running past {@link LISTING_LAG_SECONDS}, while any of its objects
 * still holds data. The others are left out, and the upload deletes them.
 */
export const keptMovers = Effect.fn(function* <E, R>({
  deployed,
  movers,
  deployedClasses,
  since,
  now,
  holdsData,
}: {
  readonly deployed: number | undefined;
  readonly movers: ReadonlyArray<DomainClass>;
  /** The classes the Worker has now, and the classes this upload renames to. */
  readonly deployedClasses: ReadonlySet<string>;
  /** When the move started, in seconds: see {@link movingSince}. */
  readonly since: number | undefined;
  readonly now: number;
  readonly holdsData: (className: string) => Effect.Effect<boolean, E, R>;
}) {
  const kept = new Set<string>();
  for (const mover of movers) {
    if (!deployedClasses.has(mover.className)) continue;
    const settled =
      deployed !== undefined &&
      deployed >= 1 &&
      since !== undefined &&
      now - since >= LISTING_LAG_SECONDS;
    if (!settled || (yield* holdsData(mover.className))) kept.add(mover.className);
  }
  return kept;
});

/**
 * The Durable Object class renames that bring a Worker deployed at `deployed`
 * up to {@link DOMAIN_VERSION} without losing data. `deployedClasses` are the
 * classes the Worker hosts now.
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
  if (deployed === undefined) {
    // none -> 0: classes were named after the definition (`AccountAggregate`),
    // now after the model too (`Billing.AccountAggregate`).
    const byLegacyName = new Map<string, Array<DomainClass>>();
    for (const domainClass of classes) {
      if (!deployedClasses.has(domainClass.legacyName)) continue;
      const sharing = byLegacyName.get(domainClass.legacyName) ?? [];
      sharing.push(domainClass);
      byLegacyName.set(domainClass.legacyName, sharing);
    }
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
      renamed.push({ from: legacyName, to: keeps[0]!.className });
    }
  }
  // 0 -> 1: nothing is renamed. The version 0 classes stay live next to the
  // shared class while their objects move (see `keptMovers`).
  return renamed;
});
