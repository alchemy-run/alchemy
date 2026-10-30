import * as DO from "@distilled.cloud/digitalocean";
import type {
  ActionStatus,
  Droplet as ApiDroplet,
  DropletSingleCreateInput,
  DropletStatus,
  ListDropletsRequest,
  NetworkV4,
  NetworkV6,
  PostDropletActionRequestBody,
} from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Stream from "effect/Stream";
import { setEquals } from "./internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import {
  generationTagFor,
  isAlchemyTag,
  ownershipTagFor,
  withoutAlchemyTags,
} from "./internal/ownership.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
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
   * `createdAt`. Once the droplet is at least this old, the next deploy
   * replaces it and its public IP, so lowering the value can replace it
   * right away. Omit to keep the droplet regardless of age.
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
 * property replaces the droplet, creating the new one before deleting the
 * old one unless it holds `volumes`. Put all setup in `userData`
 * (cloud-init) so a new droplet configures itself.
 *
 * Droplet names are not unique. Alchemy tags every droplet it creates with
 * an `alchemy:` ownership tag, built from the stack, stage and
 * fully-qualified resource name, and an `alchemy:generation:` tag for the
 * generation, so an interrupted deploy resumes on the droplet it already
 * created and a replacement never mistakes the old droplet for the new one.
 * A same-named droplet without the ownership tag is `Unowned` and needs
 * `--adopt`.
 *
 * ### Creating a Droplet
 * **Example:** Host reachable over SSH
 * ```typescript
 * const key = yield* DigitalOcean.SshKey("deploy-key", {
 *   publicKey: yield* Config.String("SSH_PUBLIC_KEY"),
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   sshKeys: [key.fingerprint],
 *   monitoring: true,
 * });
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
 *     "  - docker run -d --restart=always -p 80:80 nginx",
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
 * **Example:** Tag a droplet by role
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   tags: ["web"],
 * });
 * // A firewall given `host.tags` waits for the droplet to create the tag.
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
  readonly dropletName: string;
  readonly reason: string;
}> {
  override get message() {
    return `Droplet '${this.dropletName}' was not created: ${this.reason}.`;
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

// A droplet takes one to two minutes to create or destroy (≈ 160 s budget).
const PROVISIONING_POLL: PollBudget = { maxDelay: "5 seconds", times: 36 };

// An action finishes within seconds (≈ 50 s budget).
const ACTION_POLL: PollBudget = { maxDelay: "3 seconds", times: 20 };

// A droplet GET can lag a finished change by up to a minute (≈ 80 s budget).
const CONVERGENCE_POLL: PollBudget = { maxDelay: "5 seconds", times: 20 };

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

// `name` and `tags` update in place; every other prop can replace the droplet.
type InPlaceProp = "name" | "tags";
type ReplacementProps = Omit<DropletProps, InPlaceProp>;
const IN_PLACE_PROPS: ReadonlySet<string> = new Set<InPlaceProp>(["name", "tags"]);

const isOn = (flag: boolean | undefined) => flag ?? false;

// A value known only after deploy may differ from the deployed one.
const replacementPropsResolved = (news: Input<DropletProps>): news is ReplacementProps =>
  Object.entries(news).every(([prop, value]) => IN_PLACE_PROPS.has(prop) || isResolved(value));

// `userData`, `sshKeys` and `volumes` are write-only, so only this
// comparison reveals a change to them. Enabling `ipv6` is an action; only
// turning it off needs a new droplet.
const changedSinceLastDeploy = (news: ReplacementProps, olds: ReplacementProps) =>
  REPLACING_VALUES.some((prop) => news[prop] !== olds[prop]) ||
  REPLACING_FLAGS.some((flag) => isOn(news[flag]) !== isOn(olds[flag])) ||
  REPLACING_LISTS.some((prop) => !setEquals(news[prop], olds[prop])) ||
  (isOn(olds.ipv6) && !isOn(news.ipv6));

// Snapshots and retired images report no slug to compare with.
const imageDrifted = (image: ImageSlug | number, observed: DropletAttributes) =>
  typeof image === "number"
    ? observed.imageId !== image
    : observed.imageSlug !== undefined && observed.imageSlug !== image;

// The droplet's `features` list lags its real settings, so feature flags
// are compared with the previous deploy only.
const driftedFromCloud = (news: ReplacementProps, observed: DropletAttributes) =>
  observed.region !== news.region ||
  observed.sizeSlug !== news.size ||
  imageDrifted(news.image, observed) ||
  (news.vpcUuid !== undefined && observed.vpcUuid !== news.vpcUuid);

const isDueForReplacement = Effect.fn(function* (
  observed: DropletAttributes,
  replaceAfter: Duration.Input | undefined,
) {
  const createdAt = DateTime.make(observed.createdAt);
  if (replaceAfter === undefined || Option.isNone(createdAt)) return false;
  const now = yield* DateTime.now;
  return DateTime.isLessThanOrEqualTo(DateTime.addDuration(createdAt.value, replaceAfter), now);
});

const needsReplacement = Effect.fn(function* (
  olds: DropletProps,
  news: Input<DropletProps>,
  output: DropletAttributes | undefined,
) {
  if (!replacementPropsResolved(news)) return output !== undefined;
  if (changedSinceLastDeploy(news, olds)) return true;
  if (output === undefined) return false;
  return driftedFromCloud(news, output) || (yield* isDueForReplacement(output, news.replaceAfter));
});

// A volume attaches to one droplet at a time.
const replacement = (olds: DropletProps) =>
  ({ action: "replace", deleteFirst: (olds.volumes?.length ?? 0) > 0 }) as const;

const hasPublicIpv4 = (droplet: ApiDroplet) =>
  droplet.networks.v4?.some((network) => network.type === "public") ?? false;

// A droplet can report `active` before its public address is assigned.
const isActiveWithPublicIpv4 = (droplet: ApiDroplet) =>
  droplet.status === "active" && !droplet.locked && hasPublicIpv4(droplet);

const acceptsActions = (droplet: ApiDroplet) => droplet.status !== "new" && !droplet.locked;

const isFinished = (status: ActionStatus): status is Exclude<ActionStatus, "in-progress"> =>
  status !== "in-progress";

const needsIpv6 = (droplet: ApiDroplet, news: DropletProps) =>
  isOn(news.ipv6) && !droplet.features.includes("ipv6");

const hasConverged =
  (name: string, tags: ReadonlyArray<string>, news: DropletProps) => (droplet: ApiDroplet) =>
    droplet.name === name && setEquals(droplet.tags, tags) && !needsIpv6(droplet, news);

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

const physicalName = (id: string) =>
  createPhysicalName({
    id,
    lowercase: true,
    maxLength: NAME_MAX_LENGTH,
  });

const rejectReservedTags = (tags: ReadonlyArray<string> | undefined) =>
  Option.match(Arr.findFirst(tags ?? [], isAlchemyTag), {
    onNone: () => Effect.void,
    onSome: (tag) => Effect.fail(new DropletTagReserved({ tag })),
  });

const alchemyTagsFor = Effect.fn(function* (fqn: string, instanceId: string) {
  return [yield* ownershipTagFor(fqn), generationTagFor(instanceId)];
});

const desiredTags = Effect.fn(function* (news: DropletProps, fqn: string, instanceId: string) {
  yield* rejectReservedTags(news.tags);
  return Arr.dedupe([...(news.tags ?? []), ...(yield* alchemyTagsFor(fqn, instanceId))]);
});

const listAllDroplets = (filter: Pick<ListDropletsRequest, "name" | "tag_name" | "type">) =>
  DO.listDroplets.items({ ...filter, per_page: PAGE_SIZE }).pipe(Stream.runCollect);

const observeById = (dropletId: number) =>
  noneIfNotFound(
    DO.getDroplet({ droplet_id: dropletId }).pipe(Effect.map((response) => response.droplet)),
  );

const observeNewestTagged = (tag: string) =>
  listAllDroplets({ tag_name: tag }).pipe(
    Effect.map((droplets) => Arr.head(Arr.sort(droplets, newestFirst))),
  );

// The stored id is a cache; the generation tag finds the droplet without it.
// A replacement runs under a new instance id, so it never finds the droplet
// it replaces.
const observeGeneration = Effect.fn(function* (
  output: DropletAttributes | undefined,
  instanceId: string,
) {
  if (output !== undefined) {
    const byId = yield* observeById(output.dropletId);
    if (Option.isSome(byId)) return byId;
  }
  return yield* observeNewestTagged(generationTagFor(instanceId));
});

// A previous generation carries the ownership tag and is not a target;
// any other same-named droplet is foreign.
const observeForeignNamed = Effect.fn(function* (name: string, fqn: string) {
  const ownershipTag = yield* ownershipTagFor(fqn);
  const sameNamedDroplets = yield* listAllDroplets({ name });
  return Arr.findFirst(sameNamedDroplets, (droplet) => !droplet.tags.includes(ownershipTag));
});

const timedOut = (dropletId: number, waitingFor: string) => (last: Option.Option<ApiDroplet>) =>
  new DropletWaitTimedOut({
    dropletId,
    waitingFor,
    lastStatus: last.pipe(
      Option.map((droplet) => droplet.status),
      Option.getOrUndefined,
    ),
  });

// GET answers 404 for a moment after create.
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
    onTimeout: timedOut(dropletId, wait.waitingFor),
  }).pipe(Effect.map((observed) => observed.value));

const waitUntilProvisioned = (dropletId: number) =>
  waitForDroplet(dropletId, {
    until: isActiveWithPublicIpv4,
    waitingFor: "active with a public IPv4 address",
    budget: PROVISIONING_POLL,
  });

const waitUntilAcceptsActions = (droplet: ApiDroplet) =>
  acceptsActions(droplet)
    ? Effect.succeed(droplet)
    : waitForDroplet(droplet.id, {
        until: acceptsActions,
        waitingFor: "a state that accepts actions",
        budget: ACTION_POLL,
      });

const waitUntilConverged = (
  dropletId: number,
  name: string,
  tags: ReadonlyArray<string>,
  news: DropletProps,
) =>
  waitForDroplet(dropletId, {
    until: hasConverged(name, tags, news),
    waitingFor: `name '${name}', its tags and IPv6`,
    budget: CONVERGENCE_POLL,
  });

const waitUntilAcceptsDestroy = (droplet: ApiDroplet) =>
  acceptsActions(droplet)
    ? Effect.void
    : pollUntil(observeById(droplet.id), {
        ...ACTION_POLL,
        until: (observed) => Option.isNone(observed) || acceptsActions(observed.value),
        onTimeout: timedOut(droplet.id, "a state that accepts destroy"),
      });

const waitUntilGone = (dropletId: number) =>
  pollUntil(observeById(dropletId), {
    ...PROVISIONING_POLL,
    until: Option.isNone,
    onTimeout: timedOut(dropletId, "deletion"),
  });

// A 404 on a new action is read lag.
const observeActionStatus = (dropletId: number, actionId: number) =>
  DO.getDropletAction({ droplet_id: dropletId, action_id: actionId }).pipe(
    Effect.map((response) => response.action.status),
    Effect.catchTag("NotFound", () => Effect.succeed<ActionStatus>("in-progress")),
  );

const waitForAction = (dropletId: number, actionId: number) => {
  const failed = (status: ActionStatus) => new DropletActionFailed({ dropletId, actionId, status });
  return pollUntil(observeActionStatus(dropletId, actionId), {
    ...ACTION_POLL,
    until: isFinished,
    onTimeout: failed,
  }).pipe(Effect.filterOrFail((status) => status === "completed", failed));
};

const runAction = Effect.fn(function* (dropletId: number, body: PostDropletActionRequestBody) {
  const posted = yield* DO.postDropletAction({ droplet_id: dropletId, body });
  yield* waitForAction(dropletId, posted.action.id);
});

const dropletResource = (dropletId: number) => ({
  resource_id: String(dropletId),
  resource_type: "droplet",
});

// The assign endpoint answers 404 for a tag that does not exist yet.
const assignTag = (tag: string, dropletId: number) => {
  const assignment = DO.assignTagResources({
    tag_id: tag,
    resources: [dropletResource(dropletId)],
  });
  return assignment.pipe(
    Effect.catchTag("NotFound", () => DO.createTag({ name: tag }).pipe(Effect.andThen(assignment))),
  );
};

// Deleting a tag removes it from every droplet that carries it.
const deleteTagIfUnused = Effect.fn(function* (tag: string) {
  const tagged = yield* listAllDroplets({ tag_name: tag });
  if (tagged.length > 0) return;
  yield* ignoreNotFound(DO.deleteTag({ tag_id: tag }));
});

const deleteTagsIfUnused = (tags: ReadonlyArray<string>) =>
  Effect.forEach(tags, deleteTagIfUnused, { concurrency: "unbounded", discard: true });

const unassignTag = Effect.fn(function* (tag: string, dropletId: number) {
  yield* ignoreNotFound(
    DO.unassignTagResources({ tag_id: tag, resources: [dropletResource(dropletId)] }),
  );
  if (isAlchemyTag(tag)) yield* deleteTagIfUnused(tag);
});

// Observed tags are the baseline, so adoption drops foreign tags.
const syncTags = (droplet: ApiDroplet, desired: ReadonlyArray<string>) =>
  Effect.all(
    [
      ...Arr.difference(desired, droplet.tags).map((tag) => assignTag(tag, droplet.id)),
      ...Arr.difference(droplet.tags, desired).map((tag) => unassignTag(tag, droplet.id)),
    ],
    { concurrency: "unbounded", discard: true },
  );

const syncIpv6 = Effect.fn(function* (droplet: ApiDroplet, news: DropletProps) {
  if (!needsIpv6(droplet, news)) return;
  yield* runAction(droplet.id, { type: "enable_ipv6" });
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
      dropletName: name,
      reason: "create response carried no droplet",
    });
  }
  return yield* waitUntilProvisioned(dropletId);
});

// A resumed create can find its droplet still provisioning.
const ensureDroplet = (
  observed: Option.Option<ApiDroplet>,
  name: string,
  news: DropletProps,
  tags: ReadonlyArray<string>,
) =>
  Option.match(observed, {
    onNone: () => createDroplet(name, news, tags),
    onSome: (droplet) =>
      droplet.status === "new"
        ? waitUntilProvisioned(droplet.id)
        : waitUntilAcceptsActions(droplet),
  });

const destroyDroplet = Effect.fn(function* (droplet: ApiDroplet) {
  yield* waitUntilAcceptsDestroy(droplet);
  yield* ignoreNotFound(DO.dropletsDestroy({ droplet_id: droplet.id }));
  yield* waitUntilGone(droplet.id);
});

// DigitalOcean keeps a tag after its last droplet is destroyed. A droplet
// that is already gone no longer lists its tags, so they are rebuilt.
const alchemyTagsOf = (observed: Option.Option<ApiDroplet>, fqn: string, instanceId: string) =>
  Option.match(observed, {
    onNone: () => alchemyTagsFor(fqn, instanceId),
    onSome: (droplet) => Effect.succeed(droplet.tags.filter(isAlchemyTag)),
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
      "vpcUuid",
      "createdAt",
    ],
    list: Effect.fn(function* () {
      // The plain list hides GPU droplets behind `type=gpus`.
      const droplets = yield* Effect.forEach(
        ["droplets", "gpus"] as const,
        (type) => listAllDroplets({ type }),
        { concurrency: "unbounded" },
      );
      return droplets
        .flat()
        .filter((droplet) => droplet.tags.some(isAlchemyTag))
        .map(toAttrs);
    }),
    read: Effect.fn(function* ({ fqn, instanceId, olds, output }) {
      const ownedDroplet = yield* observeGeneration(output, instanceId);
      if (Option.isSome(ownedDroplet)) return toAttrs(ownedDroplet.value);
      if (olds.name === undefined) return undefined;
      const foreignDroplet = yield* observeForeignNamed(olds.name, fqn);
      return foreignDroplet.pipe(
        Option.map((droplet) => Unowned(toAttrs(droplet))),
        Option.getOrUndefined,
      );
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      return (yield* needsReplacement(olds, news, output)) ? replacement(olds) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, fqn, instanceId, news, output }) {
      const tags = yield* desiredTags(news, fqn, instanceId);
      const name = news.name ?? (yield* physicalName(id));

      const observed = yield* observeGeneration(output, instanceId);
      const droplet = yield* ensureDroplet(observed, name, news, tags);

      yield* syncTags(droplet, tags);
      yield* syncIpv6(droplet, news);
      yield* syncName(droplet, name);
      return toAttrs(yield* waitUntilConverged(droplet.id, name, tags, news));
    }),
    delete: Effect.fn(function* ({ fqn, instanceId, output }) {
      const observed = yield* observeById(output.dropletId);
      const alchemyTags = yield* alchemyTagsOf(observed, fqn, instanceId);
      if (Option.isSome(observed)) yield* destroyDroplet(observed.value);
      yield* deleteTagsIfUnused(alchemyTags);
    }),
  });
