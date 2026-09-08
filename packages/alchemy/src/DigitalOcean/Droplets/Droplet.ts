import * as DO from "@distilled.cloud/digitalocean";
import type {
  Droplet as ApiDroplet,
  DropletActionRename,
  DropletSingleCreateInput,
  DropletStatus,
} from "@distilled.cloud/digitalocean";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { setEquals } from "../../Util/equal.ts";
import { pollUntil, pollUntilGone, type PollOptions } from "../../Util/poll.ts";
import { sha256 } from "../../Util/sha256.ts";
import { listAllPages, PAGE_SIZE } from "../paginate.ts";
import type { Providers } from "../Providers.ts";

/** Datacenter region slug. Unlisted slugs are also accepted. */
export type RegionSlug =
  | "ams3"
  | "atl1"
  | "blr1"
  | "fra1"
  | "lon1"
  | "mem1"
  | "mkc1"
  | "nyc1"
  | "nyc2"
  | "nyc3"
  | "ric1"
  | "sfo2"
  | "sfo3"
  | "sgp1"
  | "syd1"
  | "tor1"
  | (string & {});

/** Droplet size slug. Unlisted slugs are also accepted. */
export type SizeSlug =
  | "s-1vcpu-512mb-10gb"
  | "s-1vcpu-1gb"
  | "s-1vcpu-1gb-intel"
  | "s-1vcpu-1gb-35gb-intel"
  | "s-1vcpu-2gb"
  | "s-1vcpu-2gb-intel"
  | "s-1vcpu-2gb-70gb-intel"
  | "s-2vcpu-2gb"
  | "s-2vcpu-2gb-intel"
  | "s-2vcpu-2gb-90gb-intel"
  | "s-2vcpu-4gb"
  | "s-2vcpu-4gb-intel"
  | "s-2vcpu-4gb-120gb-intel"
  | "s-2vcpu-8gb-160gb-intel"
  | "s-4vcpu-8gb"
  | "s-4vcpu-8gb-intel"
  | "s-4vcpu-8gb-240gb-intel"
  | "c-2"
  | "c-4"
  | "g-2vcpu-8gb"
  | "gd-2vcpu-8gb"
  | "m-2vcpu-16gb"
  | "gpu-4000adax1-20gb"
  | "gpu-6000adax1-48gb"
  | "gpu-l40sx1-48gb"
  | "gpu-h100x1-80gb"
  | "gpu-h100x8-640gb"
  | "gpu-h200x1-141gb"
  | "gpu-h200x8-1128gb"
  | "gpu-mi300x1-192gb"
  | "gpu-mi300x8-1536gb"
  | "gpu-mi325x1-256gb"
  | "gpu-mi325x8-2048gb"
  | "gpu-b300x1-288gb-spot"
  | "gpu-b300x1-288gb-lc-spot"
  | "gpu-b300x8-2304gb-spot"
  | "gpu-b300x8-2304gb-lc-spot"
  | "gpu-mi350x1-288gb-spot"
  | "gpu-mi350x8-2304gb-spot"
  | "gpu-mi355x1-288gb-spot"
  | "gpu-mi355x8-2304gb-spot"
  | (string & {});

/**
 * Public image slug. The list holds the distribution images. Marketplace
 * 1-Click slugs and other unlisted slugs are also accepted.
 */
export type ImageSlug =
  | "ubuntu-22-04-x64"
  | "ubuntu-24-04-x64"
  | "ubuntu-26-04-x64"
  | "debian-13-x64"
  | "fedora-43-x64"
  | "fedora-44-x64"
  | "almalinux-8-x64"
  | "almalinux-9-x64"
  | "almalinux-10-x64"
  | "rockylinux-8-x64"
  | "rockylinux-9-x64"
  | "rockylinux-10-x64"
  | "centos-stream-9-x64"
  | "centos-stream-10-x64"
  | "gpu-amd-base"
  | "gpu-h100x1-base"
  | "gpu-h100x8-base"
  | (string & {});

export type DropletProps = {
  /**
   * Droplet name. It is also the hostname. Defaults to a generated
   * physical name. A change renames the droplet in place.
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
  /** Enable automated backups. A change replaces the droplet. @default false */
  backups?: boolean;
  /** Enable IPv6. A change replaces the droplet. @default false */
  ipv6?: boolean;
  /**
   * Install the DigitalOcean monitoring agent. A change replaces the
   * droplet. @default false
   */
  monitoring?: boolean;
  /**
   * Tags to assign. Missing tags are created. A change updates the droplet
   * in place.
   */
  tags?: string[];
  /**
   * Cloud-init user data (cloud-config or shell script, at most 64 KiB).
   * It runs on first boot. A change replaces the droplet.
   */
  userData?: string;
  /** Block storage volume ids to attach at create. A change replaces the droplet. */
  volumes?: string[];
  /**
   * Maximum droplet age, in milliseconds or as a duration string
   * (`"30 days"`). The age counts from `createdAt`. When the droplet is
   * older, the next deploy replaces it and its public IP. A change to this
   * value alone does not replace.
   */
  replaceAfter?: number | (Duration.Input & string);
  /**
   * VPC for the droplet. Defaults to the default VPC of the region. A
   * change replaces the droplet.
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
    /** Tags without the ownership tag. */
    tags: string[];
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

type DropletAttributes = Droplet["Attributes"];

/**
 * A DigitalOcean Droplet: a Linux virtual machine. `name` and `tags` update
 * in place. A change to any other property replaces the droplet. The old
 * droplet is deleted first, because the name is its hostname. Put all setup
 * in `userData` (cloud-init) so a new droplet configures itself.
 *
 * Droplet names are not unique. Alchemy adds an `alchemy:` ownership tag at
 * create, built from the stack, stage, and logical id. If the state store
 * is lost, alchemy finds the droplet again through that tag. A droplet with
 * the same name but no tag is `Unowned` and needs `--adopt`.
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Droplets
 *
 * ### Creating a Droplet
 * **Example:** Host reachable over SSH
 * ```typescript
 * const key = yield* DigitalOcean.SshKey("deploy-key", {
 *   publicKey: process.env.SSH_PUBLIC_KEY!,
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
 * ### Replacing on a schedule
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
 * @resource
 * @product Droplets
 * @category Compute
 */
export const Droplet = Resource<Droplet>("DigitalOcean.Droplet");

const OWNERSHIP_TAG_PREFIX = "alchemy:";

/**
 * Tag names allow letters, numbers, colons, dashes and underscores, up to
 * 255 characters. The hash has no separator, so values that contain `:`
 * cannot collide.
 *
 * @internal exported for unit testing
 */
export const ownershipTag = (stack: string, stage: string, id: string) =>
  Effect.map(
    sha256(`${stack}\0${stage}\0${id}`),
    (digest) => OWNERSHIP_TAG_PREFIX + digest,
  );

const ownershipTagFor = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return yield* ownershipTag(stack.name, stage, id);
});

const isOwnershipTag = (tag: string) => tag.startsWith(OWNERSHIP_TAG_PREFIX);

const withoutOwnershipTags = (tags: readonly string[]) =>
  tags.filter((tag) => !isOwnershipTag(tag));

class DropletNotReady extends Data.TaggedError("DropletNotReady")<{
  readonly dropletId: number;
  readonly status: string;
}> {
  override get message() {
    return `Droplet ${this.dropletId} did not settle (last status: ${this.status}).`;
  }
}

class DropletStillPresent extends Data.TaggedError("DropletStillPresent")<{
  readonly dropletId: number;
}> {
  override get message() {
    return `Droplet ${this.dropletId} still exists after its destroy was requested.`;
  }
}

class DropletActionFailed extends Data.TaggedError("DropletActionFailed")<{
  readonly dropletId: number;
  readonly actionId: number;
  readonly status: string;
}> {
  override get message() {
    return `Droplet ${this.dropletId} action ${this.actionId} ended with status '${this.status}'.`;
  }
}

class DropletCreateFailed extends Data.TaggedError("DropletCreateFailed")<{
  readonly name: string;
  readonly reason: string;
}> {
  override get message() {
    return `Droplet '${this.name}' was not created: ${this.reason}.`;
  }
}

const ACTION_IN_PROGRESS = "in-progress";
const ACTION_COMPLETED = "completed";
const ACTION_TIMED_OUT = "timed-out";
const DROPLET_MISSING = "missing";

const isActive = (droplet: ApiDroplet) =>
  droplet.status === "active" && !droplet.locked;

/** Actions are rejected while a droplet is locked or still provisioning. */
const acceptsActions = (droplet: ApiDroplet) =>
  droplet.status !== "new" && !droplet.locked;

/** A malformed `createdAt` parses to NaN and counts as not older. */
const isOlderThan = (
  createdAt: string,
  maxAge: number | (Duration.Input & string),
  nowMs: number,
): boolean =>
  nowMs - new Date(createdAt).getTime() >= Duration.toMillis(maxAge);

const flagChanged = (a: boolean | undefined, b: boolean | undefined) =>
  (a ?? false) !== (b ?? false);

/**
 * Create-time props whose change replaces the droplet, compared against
 * the props of the previous deploy.
 *
 * @internal exported for unit testing
 */
export const changedReplacingProps = (
  news: DropletProps,
  olds: DropletProps,
): string[] => {
  const changed: string[] = [];
  if (news.region !== olds.region) changed.push("region");
  if (news.size !== olds.size) changed.push("size");
  if (news.image !== olds.image) changed.push("image");
  if (flagChanged(news.backups, olds.backups)) changed.push("backups");
  if (flagChanged(news.ipv6, olds.ipv6)) changed.push("ipv6");
  if (flagChanged(news.monitoring, olds.monitoring)) changed.push("monitoring");
  if (news.userData !== olds.userData) changed.push("userData");
  if (news.vpcUuid !== olds.vpcUuid) changed.push("vpcUuid");
  // `undefined` means the DigitalOcean image default, which is not `false`.
  if (news.withDropletAgent !== olds.withDropletAgent) {
    changed.push("withDropletAgent");
  }
  if (!setEquals(news.sshKeys, olds.sshKeys)) changed.push("sshKeys");
  if (!setEquals(news.volumes, olds.volumes)) changed.push("volumes");
  return changed;
};

/** DigitalOcean reports no slug for older droplets. A slug then cannot be checked. */
const imageDrifted = (
  image: ImageSlug | number,
  droplet: DropletAttributes,
): boolean => {
  if (typeof image === "number") return droplet.imageId !== image;
  if (droplet.imageSlug === undefined) return false;
  return droplet.imageSlug !== image;
};

/**
 * Create-time props whose change replaces the droplet, compared against
 * the observed droplet.
 *
 * @internal exported for unit testing
 */
export const driftedReplacingProps = (
  news: DropletProps,
  droplet: DropletAttributes,
): string[] => {
  const drifted: string[] = [];
  if (droplet.region !== news.region) drifted.push("region");
  if (droplet.sizeSlug !== news.size) drifted.push("size");
  if (imageDrifted(news.image, droplet)) drifted.push("image");
  const features = droplet.features;
  if (features.includes("backups") !== (news.backups ?? false)) {
    drifted.push("backups");
  }
  if (features.includes("ipv6") !== (news.ipv6 ?? false)) {
    drifted.push("ipv6");
  }
  if (features.includes("monitoring") !== (news.monitoring ?? false)) {
    drifted.push("monitoring");
  }
  if (news.vpcUuid !== undefined && droplet.vpcUuid !== news.vpcUuid) {
    drifted.push("vpcUuid");
  }
  return drifted;
};

/** Props such as `userData` and `sshKeys` are not observable. Only `olds` can show a change to them. */
const replacingChanges = (
  news: DropletProps,
  olds: DropletProps | undefined,
  droplet: DropletAttributes,
): string[] => [
  ...driftedReplacingProps(news, droplet),
  ...(olds === undefined ? [] : changedReplacingProps(news, olds)),
];

/** A droplet takes one to two minutes to create or delete. */
const DROPLET_POLL: PollOptions = { every: "5 seconds", times: 60 };

export const DropletProvider = () =>
  Provider.effect(
    Droplet,
    Effect.gen(function* () {
      const create = yield* DO.createDroplet;
      const get = yield* DO.getDroplet;
      const deleteDroplet = yield* DO.dropletsDestroy;
      const list = yield* DO.listDroplets;
      const postAction = yield* DO.postDropletAction;
      const getAction = yield* DO.getDropletAction;
      const getTag = yield* DO.getTag;
      const createTag = yield* DO.createTag;
      const deleteTag = yield* DO.deleteTag;
      const assignTag = yield* DO.assignTagResources;
      const unassignTag = yield* DO.unassignTagResources;

      const toAttrs = (droplet: ApiDroplet): DropletAttributes => ({
        dropletId: droplet.id,
        name: droplet.name,
        status: droplet.status,
        region: droplet.region.slug,
        sizeSlug: droplet.size_slug,
        imageId: droplet.image.id,
        imageSlug: droplet.image.slug ?? undefined,
        ipv4: droplet.networks.v4?.find((network) => network.type === "public")
          ?.ip_address,
        privateIpv4: droplet.networks.v4?.find(
          (network) => network.type === "private",
        )?.ip_address,
        ipv6: droplet.networks.v6?.find((network) => network.type === "public")
          ?.ip_address,
        vpcUuid: droplet.vpc_uuid,
        features: droplet.features,
        tags: withoutOwnershipTags(droplet.tags),
        createdAt: droplet.created_at,
      });

      const observeById = (dropletId: number) =>
        get({ droplet_id: dropletId }).pipe(
          Effect.map((response) => Option.some(response.droplet)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiDroplet>()),
          ),
        );

      /**
       * The ownership tag is unique per stack, stage and id, so a match is
       * ours. `tag_name` also returns GPU droplets, which the plain list
       * hides behind `type=gpus`.
       */
      const observeOwnedByTag = (ownershipTag: string) =>
        list({ tag_name: ownershipTag, per_page: PAGE_SIZE }).pipe(
          Effect.map((response) => Arr.head(response.droplets ?? [])),
        );

      const observeByName = (name: string) =>
        list({ name, per_page: PAGE_SIZE }).pipe(
          Effect.map((response) => Arr.head(response.droplets ?? [])),
        );

      /** `output` is a cache of the id. A droplet whose state was lost is found again by its tag. */
      const observeOwned = Effect.fn(function* (
        dropletId: number | undefined,
        ownershipTag: string,
      ) {
        if (dropletId !== undefined) {
          const byId = yield* observeById(dropletId);
          if (Option.isSome(byId)) return byId;
        }
        return yield* observeOwnedByTag(ownershipTag);
      });

      const notReady = (dropletId: number, last: Option.Option<ApiDroplet>) =>
        new DropletNotReady({
          dropletId,
          status: Option.match(last, {
            onNone: () => DROPLET_MISSING,
            onSome: (droplet) => droplet.status,
          }),
        });

      /**
       * A completed action can stay invisible to GET for up to a minute, so
       * every change is polled until observed. A 404 right after create is
       * the same read lag.
       */
      const waitForDroplet = (
        dropletId: number,
        settled: (droplet: ApiDroplet) => boolean,
      ) =>
        pollUntil(observeById(dropletId), settled, {
          ...DROPLET_POLL,
          notSettled: (last) => notReady(dropletId, last),
        });

      /** Like `waitForDroplet`. A droplet that no longer exists also counts as settled. */
      const waitForDropletOrGone = (
        dropletId: number,
        settled: (droplet: ApiDroplet) => boolean,
      ) =>
        pollUntil(
          observeById(dropletId).pipe(Effect.map(Option.some)),
          (droplet) => Option.isNone(droplet) || settled(droplet.value),
          {
            ...DROPLET_POLL,
            notSettled: (last) => notReady(dropletId, Option.flatten(last)),
          },
        );

      /** The public IP exists only when the status is `active`. */
      const waitForActive = (dropletId: number) =>
        waitForDroplet(dropletId, isActive);

      /** A droplet that is off is settled. Only a new or locked droplet is not. */
      const settle = (droplet: ApiDroplet) =>
        acceptsActions(droplet)
          ? Effect.succeed(droplet)
          : waitForDroplet(droplet.id, acceptsActions);

      /** The action POST answers before the action ends. */
      const waitForActionComplete = Effect.fn(function* (
        dropletId: number,
        actionId: number,
      ) {
        const status = yield* pollUntil(
          getAction({ droplet_id: dropletId, action_id: actionId }).pipe(
            Effect.map((response): Option.Option<string> =>
              Option.some(response.action.status),
            ),
            Effect.catchTag("NotFound", () =>
              Effect.succeed(Option.some(ACTION_IN_PROGRESS)),
            ),
          ),
          (status) => status !== ACTION_IN_PROGRESS,
          {
            ...DROPLET_POLL,
            notSettled: () =>
              new DropletActionFailed({
                dropletId,
                actionId,
                status: ACTION_TIMED_OUT,
              }),
          },
        );
        if (status !== ACTION_COMPLETED) {
          return yield* new DropletActionFailed({
            dropletId,
            actionId,
            status,
          });
        }
      });

      const dropletTagTarget = (dropletId: number) => ({
        resources: [
          { resource_id: String(dropletId), resource_type: "droplet" },
        ],
      });

      /** The assign endpoint needs the tag to exist. */
      const ensureTag = (tag: string) =>
        getTag({ tag_id: tag }).pipe(
          Effect.catchTag("NotFound", () => createTag({ name: tag })),
          Effect.asVoid,
        );

      const deleteOwnershipTags = (tags: Iterable<string>) =>
        Effect.forEach(
          tags,
          (tag) =>
            deleteTag({ tag_id: tag }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
            ),
          { discard: true },
        );

      /**
       * Tags diff against the observed tags, so adoption drops foreign
       * tags. The ownership tag is always desired.
       */
      const syncTags = Effect.fn(function* (
        droplet: ApiDroplet,
        userTags: string[] | undefined,
        ownershipTag: string,
      ) {
        const desired = [...new Set([...(userTags ?? []), ownershipTag])];
        const observed = droplet.tags;
        const toAdd = desired.filter((tag) => !observed.includes(tag));
        const toRemove = observed.filter((tag) => !desired.includes(tag));
        yield* Effect.forEach(toAdd, (tag) =>
          ensureTag(tag).pipe(
            Effect.andThen(
              assignTag({ tag_id: tag, ...dropletTagTarget(droplet.id) }),
            ),
          ),
        );
        yield* Effect.forEach(toRemove, (tag) =>
          unassignTag({ tag_id: tag, ...dropletTagTarget(droplet.id) }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          ),
        );
        return toAdd.length > 0 || toRemove.length > 0;
      });

      const syncName = Effect.fn(function* (
        droplet: ApiDroplet,
        desiredName: string,
      ) {
        if (droplet.name === desiredName) return false;
        const renamed = yield* postAction({
          droplet_id: droplet.id,
          body: {
            type: "rename",
            name: desiredName,
          } satisfies DropletActionRename,
        });
        yield* waitForActionComplete(droplet.id, renamed.action.id);
        return true;
      });

      const destroyDroplet = Effect.fn(function* (dropletId: number) {
        yield* waitForDropletOrGone(dropletId, acceptsActions);
        yield* deleteDroplet({ droplet_id: dropletId }).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
        yield* pollUntilGone(observeById(dropletId), {
          ...DROPLET_POLL,
          stillPresent: () => new DropletStillPresent({ dropletId }),
        });
      });

      const createDroplet = Effect.fn(function* (
        name: string,
        news: DropletProps,
        ownershipTag: string,
      ) {
        const created = yield* create({
          body: {
            name,
            region: news.region,
            size: news.size,
            image: news.image,
            ssh_keys: news.sshKeys,
            backups: news.backups,
            ipv6: news.ipv6,
            monitoring: news.monitoring,
            tags: [...(news.tags ?? []), ownershipTag],
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
        return yield* waitForActive(dropletId);
      });

      /**
       * Returns an active droplet whose create-time props match `news`. An
       * observed droplet with other create-time props is destroyed first.
       */
      const ensureDroplet = Effect.fn(function* (
        observed: Option.Option<ApiDroplet>,
        desired: {
          readonly name: string;
          readonly news: DropletProps;
          readonly olds: DropletProps | undefined;
          readonly ownershipTag: string;
        },
      ) {
        if (Option.isSome(observed)) {
          const droplet = yield* settle(observed.value);
          const changes = replacingChanges(
            desired.news,
            desired.olds,
            toAttrs(droplet),
          );
          if (changes.length === 0) return droplet;
          yield* Effect.logInfo(
            `Droplet ${droplet.id} is replaced: ${changes.join(", ")} changed.`,
          );
          yield* destroyDroplet(droplet.id);
        }
        return yield* createDroplet(
          desired.name,
          desired.news,
          desired.ownershipTag,
        );
      });

      return {
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
        /** Only droplets with an ownership tag. GPU droplets are listed under `type=gpus`. */
        list: Effect.fn(function* () {
          const [plain, gpus] = yield* Effect.all(
            [
              listAllPages(
                (query) => list({ ...query, type: "droplets" }),
                (response) => response.droplets ?? [],
              ),
              listAllPages(
                (query) => list({ ...query, type: "gpus" }),
                (response) => response.droplets ?? [],
              ),
            ],
            { concurrency: 2 },
          );
          return [...plain, ...gpus]
            .filter((droplet) => droplet.tags.some(isOwnershipTag))
            .map(toAttrs);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const ownershipTag = yield* ownershipTagFor(id);
          const owned = yield* observeOwned(output?.dropletId, ownershipTag);
          if (Option.isSome(owned)) return toAttrs(owned.value);
          // A same-named droplet without the tag belongs to someone else
          // until `--adopt` says otherwise.
          if (olds?.name === undefined) return undefined;
          const foreign = yield* observeByName(olds.name);
          return Option.getOrUndefined(
            Option.map(foreign, (droplet) => Unowned(toAttrs(droplet))),
          );
        }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const replace = { action: "replace", deleteFirst: true } as const;
          if (
            output !== undefined &&
            driftedReplacingProps(news, output).length > 0
          ) {
            return replace;
          }
          if (olds === undefined) return undefined;
          if (output !== undefined && news.replaceAfter !== undefined) {
            const now = yield* Clock.currentTimeMillis;
            if (isOlderThan(output.createdAt, news.replaceAfter, now)) {
              return replace;
            }
          }
          if (changedReplacingProps(news, olds).length > 0) return replace;
          if (news.name !== olds.name || !setEquals(news.tags, olds.tags)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output }) {
          const ownershipTag = yield* ownershipTagFor(id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }));

          const observed = yield* observeOwned(output?.dropletId, ownershipTag);
          const droplet = yield* ensureDroplet(observed, {
            name: desiredName,
            news,
            olds,
            ownershipTag,
          });

          const tagsChanged = yield* syncTags(droplet, news.tags, ownershipTag);
          const nameChanged = yield* syncName(droplet, desiredName);
          if (!tagsChanged && !nameChanged) return toAttrs(droplet);
          const updated = yield* waitForDroplet(
            droplet.id,
            (current) =>
              acceptsActions(current) &&
              current.name === desiredName &&
              setEquals(withoutOwnershipTags(current.tags), news.tags),
          );
          return toAttrs(updated);
        }),
        /** Tags outlive droplets. The ownership tags go after the droplet is gone. */
        delete: Effect.fn(function* ({ id, output }) {
          const current = yield* observeById(output.dropletId);
          const ownershipTags = new Set([
            yield* ownershipTagFor(id),
            ...Option.match(current, {
              onNone: () => [],
              onSome: (droplet) => droplet.tags.filter(isOwnershipTag),
            }),
          ]);
          yield* destroyDroplet(output.dropletId);
          yield* deleteOwnershipTags(ownershipTags);
        }),
      };
    }),
  );
