import * as DO from "@distilled.cloud/digitalocean";
import type {
  ActionStatus,
  Droplet as ApiDroplet,
  DropletSingleCreateInput,
  DropletStatus,
  NetworkV4,
  NetworkV6,
  PostDropletActionRequestBody,
} from "@distilled.cloud/digitalocean";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import type { Input } from "../Input.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { setEquals } from "../Util/equal.ts";
import { pollUntil, type PollBudget } from "../Util/poll.ts";
import { ignoreNotFound, noneIfNotFound } from "./notFound.ts";
import {
  generationTagFor,
  isAlchemyTag,
  ownershipTagFor,
  withoutAlchemyTags,
} from "./ownership.ts";
import type { Providers } from "./Providers.ts";
import type { ImageSlug, RegionSlug, SizeSlug } from "./Slugs.ts";

export type { DropletStatus } from "@distilled.cloud/digitalocean";

export type DropletProps = {
  /**
   * Droplet name. It is also the hostname. A change renames the droplet in
   * place.
   *
   * @default a generated physical name
   */
  name?: string;

  /** Region slug. A change replaces the droplet. */
  region: RegionSlug;

  /** Size slug. A change replaces the droplet. */
  size: SizeSlug;

  /** Public image slug or private image id. A change replaces the droplet. */
  image: ImageSlug | number;

  /**
   * SSH key ids or fingerprints for the root account. The keys must exist
   * on the team. A change replaces the droplet.
   */
  sshKeys?: Array<string | number>;

  /**
   * Enable automated backups. A change replaces the droplet.
   *
   * @default false
   */
  backups?: boolean;

  /**
   * Enable IPv6. Enabling updates the droplet in place. Disabling replaces
   * it, because DigitalOcean cannot remove an IPv6 address.
   *
   * @default false
   */
  ipv6?: boolean;

  /**
   * Install the DigitalOcean monitoring agent. A change replaces the
   * droplet.
   *
   * @default false
   */
  monitoring?: boolean;

  /**
   * Tags to assign. Missing tags are created. A change updates the droplet
   * in place. The `alchemy:` prefix is reserved.
   */
  tags?: string[];

  /**
   * Cloud-init user data (cloud-config or shell script, at most 64 KiB).
   * It runs on first boot. A change replaces the droplet.
   */
  userData?: string;

  /**
   * Block storage volume ids to attach at create. A change replaces the
   * droplet. A volume attaches to one droplet at a time, so a droplet that
   * holds volumes is deleted before its replacement is created.
   */
  volumes?: string[];

  /**
   * Maximum droplet age, for example `"30 days"`. The age counts from
   * `createdAt`. When the droplet is older, the next deploy replaces it and
   * its public IP. A change to this value alone does not replace.
   */
  replaceAfter?: Duration.Input;

  /**
   * VPC for the droplet. A change replaces the droplet.
   *
   * @default the default VPC of the region
   */
  vpcUuid?: string;

  /**
   * Install the droplet agent for web-console access. Omit to use the
   * DigitalOcean default for the image. A change replaces the droplet.
   */
  withDropletAgent?: boolean;
};

export type Droplet = Resource<
  "DigitalOcean.Droplet",
  DropletProps,
  {
    /** Numeric droplet id. */
    dropletId: number;
    /** Droplet name and hostname. */
    name: string;
    /** Droplet status, for example `active`. */
    status: DropletStatus;
    /** Region slug. */
    region: string;
    /** Size slug. */
    sizeSlug: string;
    /** Image id. */
    imageId: number | undefined;
    /** Image slug, when DigitalOcean reports one. */
    imageSlug: string | undefined;
    /** Public IPv4 address. */
    ipv4: string | undefined;
    /** VPC-private IPv4 address. */
    privateIpv4: string | undefined;
    /** Public IPv6 address, when `ipv6` is enabled. */
    ipv6: string | undefined;
    /** VPC id. */
    vpcUuid: string | undefined;
    /** Enabled features, for example `backups`, `ipv6`, `monitoring`. */
    features: string[];
    /** Tags without the `alchemy:` tags. */
    tags: string[];
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type DropletAttributes = Droplet["Attributes"];

/**
 * A DigitalOcean Droplet: a Linux virtual machine. `name` and `tags`
 * update in place, and so does enabling `ipv6`. A change to any other
 * property replaces the droplet: the new droplet is created first, then
 * the old one is deleted. Put all setup in `userData` (cloud-init) so
 * a new droplet configures itself.
 *
 * Droplet names are not unique. Alchemy adds an `alchemy:` ownership tag at
 * create, built from the stack, stage, and fully-qualified resource name.
 * If the state store is lost, alchemy finds the droplet again through that
 * tag. A droplet with the same name but no tag is `Unowned` and needs
 * `--adopt`.
 *
 * ### Creating a Droplet
 * **Example:** Host reachable over SSH
 * ```typescript
 * const key = yield* DigitalOcean.SshKey("deploy-key", {
 *   publicKey: yield* Config.string("SSH_PUBLIC_KEY"),
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   sshKeys: [key.fingerprint],
 *   monitoring: true,
 * });
 * // host.ipv4 is the public address once the droplet is active.
 * ```
 *
 * **Example:** Bootstrap via cloud-init
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   userData: [
 *     "#cloud-config",
 *     "packages: [docker.io]",
 *     "runcmd:",
 *     "  - docker compose -f /opt/app/compose.yaml up -d",
 *   ].join("\n"),
 * });
 * ```
 *
 * ### Replacing on a Schedule
 * **Example:** Rebuild monthly on a fresh image
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   // After 30 days the next deploy creates a new droplet with a new IP.
 *   replaceAfter: "30 days",
 *   userData: "#cloud-config\npackages: [docker.io]",
 * });
 * ```
 *
 * ### Tagging
 * **Example:** Tag droplets so a firewall can target them by role
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   tags: ["web"], // updated in place
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Droplets
 *
 * @resource
 * @product Droplets
 * @category Compute
 */
export const Droplet = Resource<Droplet>("DigitalOcean.Droplet");

export class DropletWaitTimedOut extends Data.TaggedError("DigitalOcean.DropletWaitTimedOut")<{
  readonly dropletId: number;
  readonly waitingFor: string;
  readonly lastStatus: DropletStatus | undefined;
}> {
  override get message() {
    const last = this.lastStatus ?? "not found";
    return `Droplet ${this.dropletId} timed out waiting for ${this.waitingFor} (last status: ${last}).`;
  }
}

export class DropletActionFailed extends Data.TaggedError("DigitalOcean.DropletActionFailed")<{
  readonly dropletId: number;
  readonly actionId: number;
  readonly status: ActionStatus;
}> {
  override get message() {
    return `Droplet ${this.dropletId} action ${this.actionId} did not complete (last status: '${this.status}').`;
  }
}

export class DropletCreateFailed extends Data.TaggedError("DigitalOcean.DropletCreateFailed")<{
  readonly name: string;
  readonly reason: string;
}> {
  override get message() {
    return `Droplet '${this.name}' was not created: ${this.reason}.`;
  }
}

export class DropletTagReserved extends Data.TaggedError("DigitalOcean.DropletTagReserved")<{
  readonly tag: string;
}> {
  override get message() {
    return `Tag '${this.tag}' uses the 'alchemy:' prefix, which is reserved for ownership tags.`;
  }
}

// Hostname label limit.
const NAME_MAX_LENGTH = 63;

const PAGE_SIZE = 200;

// A droplet takes one to two minutes to create or destroy.
const PROVISIONING_POLL: PollBudget = { every: "5 seconds", times: 36 };

// An action or a rename shows within seconds.
const ACTION_POLL: PollBudget = { every: "3 seconds", times: 20 };

const REPLACING_VALUES = [
  "region",
  "size",
  "image",
  "userData",
  "vpcUuid",
  // `undefined` keeps the image default, which is not `false`.
  "withDropletAgent",
] as const;
const REPLACING_FLAGS = ["backups", "monitoring"] as const;
const REPLACING_LISTS = ["sshKeys", "volumes"] as const;
// Enabling `ipv6` is an action; only turning it off needs a new droplet.
const REPLACING_PROPS: ReadonlySet<string> = new Set([
  ...REPLACING_VALUES,
  ...REPLACING_FLAGS,
  ...REPLACING_LISTS,
  "ipv6",
]);

const isOn = (flag: boolean | undefined) => flag ?? false;

/**
 * Props that replace the droplet and differ from the previous deploy.
 * `userData`, `sshKeys` and `volumes` are write-only, so only this
 * comparison reveals a change to them.
 *
 * @internal exported for unit testing
 */
export const propsChangedSinceLastDeploy = (news: DropletProps, olds: DropletProps): string[] => [
  ...REPLACING_VALUES.filter((prop) => news[prop] !== olds[prop]),
  ...REPLACING_FLAGS.filter((flag) => isOn(news[flag]) !== isOn(olds[flag])),
  ...REPLACING_LISTS.filter((prop) => !setEquals(news[prop], olds[prop])),
  ...(isOn(olds.ipv6) && !isOn(news.ipv6) ? ["ipv6"] : []),
];

// Snapshots and retired images report no slug to compare with.
const imageDrifted = (image: ImageSlug | number, observed: DropletAttributes): boolean => {
  if (typeof image === "number") return observed.imageId !== image;
  return observed.imageSlug !== undefined && observed.imageSlug !== image;
};

/**
 * Props that replace the droplet and differ from the observed droplet.
 * The droplet's `features` list lags its real settings, so feature flags
 * are compared with the previous deploy only.
 *
 * @internal exported for unit testing
 */
export const propsDriftedFromCloud = (
  news: DropletProps,
  observed: DropletAttributes,
): string[] => {
  const vpcDrifted = news.vpcUuid !== undefined && observed.vpcUuid !== news.vpcUuid;
  return [
    ...(observed.region !== news.region ? ["region"] : []),
    ...(observed.sizeSlug !== news.size ? ["size"] : []),
    ...(imageDrifted(news.image, observed) ? ["image"] : []),
    ...(vpcDrifted ? ["vpcUuid"] : []),
  ];
};

// A value known only after deploy may differ from the deployed one.
const hasUnresolvedReplacingProp = (news: object) =>
  Object.entries(news).some(([prop, value]) => REPLACING_PROPS.has(prop) && !isResolved(value));

// A volume attaches to one droplet at a time, so a droplet that holds
// volumes must go before its replacement can take them.
const replacement = (olds: DropletProps) =>
  ({ action: "replace", deleteFirst: (olds.volumes?.length ?? 0) > 0 }) as const;

// A malformed `createdAt` parses to NaN and counts as not older.
const isOlderThan = (createdAt: string, maxAge: Duration.Input, nowMs: number): boolean =>
  nowMs - Date.parse(createdAt) >= Duration.toMillis(maxAge);

const isDueForReplacement = Effect.fn(function* (
  observed: DropletAttributes,
  replaceAfter: Duration.Input | undefined,
) {
  if (replaceAfter === undefined) return false;
  const now = yield* Clock.currentTimeMillis;
  return isOlderThan(observed.createdAt, replaceAfter, now);
});

/**
 * Replaces on drift, on age, and on a changed create-time prop. Every other
 * change is left to the engine's in-place update.
 *
 * @internal exported for unit testing
 */
export const diffDroplet = Effect.fn(function* ({
  olds,
  news,
  output,
}: {
  readonly olds: DropletProps;
  readonly news: Input<DropletProps>;
  readonly output: DropletAttributes | undefined;
}) {
  if (!isResolved(news)) {
    const needsReplacement = output !== undefined && hasUnresolvedReplacingProp(news);
    return needsReplacement ? replacement(olds) : undefined;
  }
  if (output !== undefined && propsDriftedFromCloud(news, output).length > 0) {
    return replacement(olds);
  }
  if (output !== undefined && (yield* isDueForReplacement(output, news.replaceAfter))) {
    return replacement(olds);
  }
  if (propsChangedSinceLastDeploy(news, olds).length > 0) return replacement(olds);
  return undefined;
});

const hasPublicIpv4 = (droplet: ApiDroplet) =>
  droplet.networks.v4?.some((network) => network.type === "public") ?? false;

// A droplet can report `active` before its public address is assigned.
const isActiveWithPublicIpv4 = (droplet: ApiDroplet) =>
  droplet.status === "active" && !droplet.locked && hasPublicIpv4(droplet);

// Actions are rejected while a droplet is locked or still provisioning.
const acceptsActions = (droplet: ApiDroplet) => droplet.status !== "new" && !droplet.locked;

const isFinished = (status: ActionStatus): status is Exclude<ActionStatus, "in-progress"> =>
  status !== "in-progress";

const newestFirst = Order.mapInput(
  Order.flip(Order.String),
  (droplet: ApiDroplet) => droplet.created_at,
);

const publicAddress = (networks: ReadonlyArray<NetworkV4 | NetworkV6> | undefined) =>
  networks?.find((network) => network.type === "public")?.ip_address;

const privateAddress = (networks: ReadonlyArray<NetworkV4> | undefined) =>
  networks?.find((network) => network.type === "private")?.ip_address;

const toAttrs = (droplet: ApiDroplet): DropletAttributes => ({
  dropletId: droplet.id,
  name: droplet.name,
  status: droplet.status,
  region: droplet.region.slug,
  sizeSlug: droplet.size_slug,
  imageId: droplet.image.id,
  imageSlug: droplet.image.slug ?? undefined,
  ipv4: publicAddress(droplet.networks.v4),
  privateIpv4: privateAddress(droplet.networks.v4),
  ipv6: publicAddress(droplet.networks.v6),
  vpcUuid: droplet.vpc_uuid,
  features: droplet.features,
  tags: withoutAlchemyTags(droplet.tags),
  createdAt: droplet.created_at,
});

const taggedAs = (dropletId: number) => ({
  resources: [{ resource_id: String(dropletId), resource_type: "droplet" }],
});

const rejectReservedTags = (tags: ReadonlyArray<string> | undefined) =>
  Option.match(Arr.findFirst(tags ?? [], isAlchemyTag), {
    onNone: () => Effect.void,
    onSome: (tag) => Effect.fail(new DropletTagReserved({ tag })),
  });

const featureActions = (droplet: ApiDroplet, news: DropletProps): PostDropletActionRequestBody[] =>
  isOn(news.ipv6) && !droplet.features.includes("ipv6") ? [{ type: "enable_ipv6" }] : [];

const hasConverged =
  (name: string, tags: ReadonlyArray<string>, news: DropletProps) => (droplet: ApiDroplet) =>
    droplet.name === name &&
    setEquals(droplet.tags, tags) &&
    featureActions(droplet, news).length === 0;

const physicalName = (id: string) =>
  createPhysicalName({
    id,
    lowercase: true,
    maxLength: NAME_MAX_LENGTH,
  });

const observeById = (dropletId: number) =>
  noneIfNotFound(
    DO.getDroplet({ droplet_id: dropletId }).pipe(Effect.map((response) => response.droplet)),
  );

// `tag_name` also returns GPU droplets, which the plain list hides
// behind `type=gpus`.
const listTagged = (tag: string) =>
  DO.listDroplets.items({ tag_name: tag, per_page: PAGE_SIZE }).pipe(Stream.runCollect);

const listOfType = (type: "droplets" | "gpus") =>
  DO.listDroplets.items({ type, per_page: PAGE_SIZE }).pipe(Stream.runCollect);

const observeNewestTagged = (tag: string) =>
  listTagged(tag).pipe(Effect.map((droplets) => Arr.head(Arr.sort(droplets, newestFirst))));

const observeByName = (name: string) =>
  DO.listDroplets({ name, per_page: 1 }).pipe(
    Effect.map((response) => Arr.head(response.droplets ?? [])),
  );

// The stored id is a cache. The tag finds the droplet without it.
const observeByIdOrTag = Effect.fn(function* (dropletId: number | undefined, tag: string) {
  if (dropletId !== undefined) {
    const byId = yield* observeById(dropletId);
    if (Option.isSome(byId)) return byId;
  }
  return yield* observeNewestTagged(tag);
});

const lastStatusOf = (last: Option.Option<ApiDroplet>) =>
  Option.getOrUndefined(Option.map(last, (droplet) => droplet.status));

// GET can lag a change by up to a minute, and answers 404 right after
// create, so every change is polled until observed.
const waitForDroplet = (
  dropletId: number,
  wait: {
    readonly until: (droplet: ApiDroplet) => boolean;
    readonly waitingFor: string;
    readonly budget: PollBudget;
  },
) =>
  pollUntil(observeById(dropletId), {
    ...wait.budget,
    until: (observed): observed is Option.Some<ApiDroplet> =>
      Option.isSome(observed) && wait.until(observed.value),
    onTimeout: (last) =>
      new DropletWaitTimedOut({
        dropletId,
        waitingFor: wait.waitingFor,
        lastStatus: lastStatusOf(last),
      }),
  }).pipe(Effect.map((observed) => observed.value));

const waitUntilAcceptsActions = (droplet: ApiDroplet) =>
  acceptsActions(droplet)
    ? Effect.succeed(droplet)
    : waitForDroplet(droplet.id, {
        until: acceptsActions,
        waitingFor: "a state that accepts actions",
        budget: ACTION_POLL,
      });

const waitUntilGone = (dropletId: number) =>
  pollUntil(observeById(dropletId), {
    ...PROVISIONING_POLL,
    until: Option.isNone,
    onTimeout: (last) =>
      new DropletWaitTimedOut({
        dropletId,
        waitingFor: "deletion",
        lastStatus: lastStatusOf(last),
      }),
  });

// A 404 on a new action is read lag.
const observeActionStatus = (dropletId: number, actionId: number) =>
  DO.getDropletAction({ droplet_id: dropletId, action_id: actionId }).pipe(
    Effect.map((response) => response.action.status),
    Effect.catchTag("NotFound", () => Effect.succeed<ActionStatus>("in-progress")),
  );

const waitForAction = (dropletId: number, actionId: number) =>
  pollUntil(observeActionStatus(dropletId, actionId), {
    ...ACTION_POLL,
    until: isFinished,
    onTimeout: (status) => new DropletActionFailed({ dropletId, actionId, status }),
  }).pipe(
    Effect.filterOrFail(
      (status) => status === "completed",
      (status) => new DropletActionFailed({ dropletId, actionId, status }),
    ),
  );

const runAction = Effect.fn(function* (dropletId: number, body: PostDropletActionRequestBody) {
  const posted = yield* DO.postDropletAction({ droplet_id: dropletId, body });
  yield* waitForAction(dropletId, posted.action.id);
});

// The assign endpoint answers 404 for a tag that does not exist yet.
const assign = (tag: string, dropletId: number) => {
  const assignment = DO.assignTagResources({ tag_id: tag, ...taggedAs(dropletId) });
  return assignment.pipe(
    Effect.catchTag("NotFound", () => DO.createTag({ name: tag }).pipe(Effect.andThen(assignment))),
  );
};

// Deleting a tag removes it from every droplet that carries it.
const deleteTagIfUnused = Effect.fn(function* (tag: string) {
  const tagged = yield* listTagged(tag);
  if (tagged.length > 0) return;
  yield* ignoreNotFound(DO.deleteTag({ tag_id: tag }));
});

const unassign = Effect.fn(function* (tag: string, dropletId: number) {
  yield* ignoreNotFound(DO.unassignTagResources({ tag_id: tag, ...taggedAs(dropletId) }));
  if (isAlchemyTag(tag)) yield* deleteTagIfUnused(tag);
});

// Observed tags are the baseline, so adoption drops foreign tags.
const syncTags = (droplet: ApiDroplet, desired: ReadonlyArray<string>) => {
  const observed = droplet.tags;
  const missing = desired.filter((tag) => !observed.includes(tag));
  const unwanted = observed.filter((tag) => !desired.includes(tag));
  return Effect.all(
    [
      Effect.forEach(missing, (tag) => assign(tag, droplet.id), {
        concurrency: "unbounded",
        discard: true,
      }),
      Effect.forEach(unwanted, (tag) => unassign(tag, droplet.id), {
        concurrency: "unbounded",
        discard: true,
      }),
    ],
    { concurrency: "unbounded", discard: true },
  );
};

// Each action locks the droplet until it finishes.
const syncFeatures = (droplet: ApiDroplet, news: DropletProps) =>
  Effect.forEach(featureActions(droplet, news), (body) => runAction(droplet.id, body), {
    discard: true,
  });

const syncName = Effect.fn(function* (droplet: ApiDroplet, name: string) {
  if (droplet.name === name) return;
  yield* runAction(droplet.id, { type: "rename", name });
});

const createDroplet = Effect.fn(function* (
  name: string,
  news: DropletProps,
  tags: ReadonlyArray<string>,
) {
  const created = yield* DO.createDroplet({
    body: {
      name,
      region: news.region,
      size: news.size,
      image: news.image,
      ssh_keys: news.sshKeys,
      backups: news.backups,
      ipv6: news.ipv6,
      monitoring: news.monitoring,
      tags: [...tags],
      user_data: news.userData,
      volumes: news.volumes,
      vpc_uuid: news.vpcUuid,
      with_droplet_agent: news.withDropletAgent,
    } satisfies DropletSingleCreateInput,
  });
  const dropletId = created.droplet?.id;
  if (dropletId === undefined) {
    return yield* new DropletCreateFailed({
      name,
      reason: "create response carried no droplet",
    });
  }
  return yield* waitForDroplet(dropletId, {
    until: isActiveWithPublicIpv4,
    waitingFor: "active with a public IPv4 address",
    budget: PROVISIONING_POLL,
  });
});

const ensureDroplet = (
  observed: Option.Option<ApiDroplet>,
  name: string,
  news: DropletProps,
  tags: ReadonlyArray<string>,
) =>
  Option.match(observed, {
    onNone: () => createDroplet(name, news, tags),
    onSome: waitUntilAcceptsActions,
  });

const waitUntilAcceptsDestroy = (dropletId: number) =>
  pollUntil(observeById(dropletId), {
    ...ACTION_POLL,
    until: (observed) => Option.isNone(observed) || acceptsActions(observed.value),
    onTimeout: (last) =>
      new DropletWaitTimedOut({
        dropletId,
        waitingFor: "a state that accepts destroy",
        lastStatus: lastStatusOf(last),
      }),
  });

const destroyDroplet = Effect.fn(function* (dropletId: number) {
  yield* waitUntilAcceptsDestroy(dropletId);
  yield* ignoreNotFound(DO.dropletsDestroy({ droplet_id: dropletId }));
  yield* waitUntilGone(dropletId);
});

export const DropletProvider = () =>
  Provider.succeed(Droplet, {
    stables: [
      "dropletId",
      "region",
      "sizeSlug",
      "imageId",
      "imageSlug",
      "ipv4",
      "privateIpv4",
      "ipv6",
      "vpcUuid",
      "createdAt",
    ],
    list: Effect.fn(function* () {
      const droplets = yield* Effect.forEach(["droplets", "gpus"] as const, listOfType, {
        concurrency: "unbounded",
      });
      return droplets
        .flat()
        .filter((droplet) => droplet.tags.some(isAlchemyTag))
        .map(toAttrs);
    }),
    read: Effect.fn(function* ({ fqn, olds, output }) {
      const ownedDroplet = yield* observeByIdOrTag(output?.dropletId, yield* ownershipTagFor(fqn));
      if (Option.isSome(ownedDroplet)) return toAttrs(ownedDroplet.value);
      // A same-named droplet without the tag belongs to someone else
      // until `--adopt` says otherwise.
      if (olds.name === undefined) return undefined;
      const foreignDroplet = yield* observeByName(olds.name);
      return Option.getOrUndefined(
        Option.map(foreignDroplet, (droplet) => Unowned(toAttrs(droplet))),
      );
    }),
    diff: diffDroplet,
    reconcile: Effect.fn(function* ({ id, fqn, instanceId, news, output }) {
      yield* rejectReservedTags(news.tags);
      const name = news.name ?? (yield* physicalName(id));
      const generationTag = generationTagFor(instanceId);
      const tags = Arr.dedupe([...(news.tags ?? []), yield* ownershipTagFor(fqn), generationTag]);

      // The ownership tag is not a fallback here: a replacement shares
      // it with the droplet it replaces.
      const observed = yield* observeByIdOrTag(output?.dropletId, generationTag);
      const droplet = yield* ensureDroplet(observed, name, news, tags);

      yield* syncTags(droplet, tags);
      yield* syncFeatures(droplet, news);
      yield* syncName(droplet, name);
      const convergedDroplet = yield* waitForDroplet(droplet.id, {
        until: hasConverged(name, tags, news),
        waitingFor: `name '${name}', its tags and features`,
        budget: ACTION_POLL,
      });
      return toAttrs(convergedDroplet);
    }),
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* observeById(output.dropletId);
      if (Option.isNone(observed)) return;
      const droplet = observed.value;
      yield* destroyDroplet(droplet.id);
      // DigitalOcean keeps a tag after its last droplet is destroyed.
      yield* Effect.forEach(droplet.tags.filter(isAlchemyTag), deleteTagIfUnused, {
        concurrency: "unbounded",
        discard: true,
      });
    }),
  });
