import {
  dropletActionsGet,
  dropletActionsPost,
  dropletsCreate,
  dropletsDestroy,
  dropletsGet,
  dropletsList,
  type Droplet as ApiDroplet,
  type DropletActionRename,
  type DropletSingleCreateInput,
  type DropletStatus,
} from "@distilled.cloud/digitalocean/droplets";
import {
  tagsAssignResources,
  tagsCreate,
  tagsUnassignResources,
  type TagsCreateError,
} from "@distilled.cloud/digitalocean/tags";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createHash } from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { ReplacementRequired } from "../../ReplacementRequired.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { sameElements } from "../../Util/equal.ts";
import { listAllPages, PAGE_SIZE } from "../paginate.ts";
import { pollUntil, pollUntilGone, type PollOptions } from "../poll.ts";
import type { Providers } from "../Providers.ts";

/**
 * Datacenter region slug. The union is open (`string & {}`) so regions
 * newer than this list still typecheck.
 */
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

/**
 * Droplet size slug. Open union, like {@link RegionSlug} — unlisted
 * slugs still typecheck.
 */
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
 * Public image slug. Lists the distribution images; Marketplace 1-Click
 * slugs pass through the open union. Like {@link RegionSlug}, unlisted
 * slugs still typecheck.
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
   * Droplet name (also its hostname). Defaults to a generated physical
   * name. Renames in place.
   */
  name?: string;
  /** Region slug to deploy into. Replaces. */
  region: RegionSlug;
  /** Droplet size slug. Replaces. */
  size: SizeSlug;
  /** Public image slug or private image id. Replaces. */
  image: ImageSlug | number;
  /**
   * SSH key ids or fingerprints to embed in the root account. Keys must
   * already exist on the team. Replaces.
   */
  sshKeys?: Array<string | number>;
  /** Enable automated backups. Replaces. @default false */
  backups?: boolean;
  /** Enable IPv6. Replaces. @default false */
  ipv6?: boolean;
  /** Install the DigitalOcean monitoring agent. Replaces. @default false */
  monitoring?: boolean;
  /**
   * Tags to apply. Created on the fly if they don't exist; synced in
   * place.
   */
  tags?: string[];
  /**
   * Cloud-init user data (cloud-config or shell script, ≤64KiB) applied on
   * first boot. Replaces.
   */
  userData?: string;
  /** Block storage volume ids to attach on creation. Replaces. */
  volumes?: string[];
  /**
   * Maximum droplet age, as milliseconds or a duration string
   * (`"30 days"`). Age counts from `createdAt`. When the age is exceeded,
   * the next deploy replaces the droplet and its public IP. A change to
   * this value alone does not replace.
   */
  replaceAfter?: number | (Duration.Input & string);
  /**
   * VPC to assign the droplet to. Defaults to the region's default VPC.
   * Replaces.
   */
  vpcUuid?: string;
  /**
   * Install the droplet-console agent for web-console access. Omit to
   * accept DigitalOcean's default for the image. Replaces.
   */
  withDropletAgent?: boolean;
};

export type Droplet = Resource<
  "DigitalOcean.Droplet",
  DropletProps,
  {
    dropletId: number;
    name: string;
    status: DropletStatus;
    region: string;
    sizeSlug: string;
    imageId: number | undefined;
    imageSlug: string | undefined;
    /** Public IPv4 address. */
    ipv4: string | undefined;
    /** VPC-private IPv4 address. */
    privateIpv4: string | undefined;
    /** Public IPv6 address, when `ipv6` is enabled. */
    ipv6: string | undefined;
    vpcUuid: string | undefined;
    /** Enabled features, e.g. `backups`, `ipv6`, `monitoring`. */
    features: string[];
    tags: string[];
    createdAt: string;
  },
  never,
  Providers
>;

type DropletAttributes = Droplet["Attributes"];

/**
 * A DigitalOcean Droplet — a Linux virtual machine. `name` and `tags` sync
 * in place; every other property replaces the droplet (delete-first, since
 * the name is its hostname). Provision via `userData` (cloud-init) so a
 * replacement converges on its own.
 *
 * Ownership: droplet names are not unique, so alchemy stamps an `alchemy:`
 * ownership tag derived from the stack, stage and id at create. A wiped
 * state store recovers the droplet through that tag; a same-named droplet
 * without it surfaces as `Unowned` and requires `--adopt`.
 *
 * @resource
 * @product Droplets
 * @category Compute
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Droplets
 *
 * @section Creating a Droplet
 * @example Host reachable over SSH
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
 * @example Bootstrap via cloud-init
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
 * @section Replacing on a schedule
 * @example Rebuild monthly on a fresh image
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   // Duration string or milliseconds. Once the droplet is older
 *   // than this, the next deploy replaces it — new host, new IP.
 *   replaceAfter: "30 days",
 *   userData: "#cloud-config\npackages: [docker.io]",
 * });
 * ```
 *
 * @section Tagging
 * @example Tag droplets so a firewall can target them by role
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   tags: ["web"], // synced in place; no replacement
 * });
 * ```
 */
export const Droplet = Resource<Droplet>("DigitalOcean.Droplet");

const OWNERSHIP_TAG_PREFIX = "alchemy:";

/**
 * Tag names allow letters, numbers, colons, dashes and underscores, up to
 * 255 characters. The hex digest keeps `stack`, `stage` and `id` apart
 * without a separator that any of them could contain.
 *
 * @internal exported for unit testing
 */
export const ownershipTag = (stack: string, stage: string, id: string) =>
  OWNERSHIP_TAG_PREFIX +
  createHash("sha256").update(`${stack}\0${stage}\0${id}`).digest("hex");

const ownershipMarker = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return ownershipTag(stack.name, stage, id);
});

const withoutOwnershipTags = (tags: readonly string[]) =>
  tags.filter((t) => !t.startsWith(OWNERSHIP_TAG_PREFIX));

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

const boolChanged = (a: boolean | undefined, b: boolean | undefined) =>
  (a ?? false) !== (b ?? false);

/**
 * Create-time props whose change replaces the droplet, compared against
 * the props of the previous deploy.
 *
 * @internal exported for unit testing
 */
export const changedImmutableProps = (
  news: DropletProps,
  olds: DropletProps,
): string[] => {
  const changed: string[] = [];
  if (news.region !== olds.region) changed.push("region");
  if (news.size !== olds.size) changed.push("size");
  if (news.image !== olds.image) changed.push("image");
  if (boolChanged(news.backups, olds.backups)) changed.push("backups");
  if (boolChanged(news.ipv6, olds.ipv6)) changed.push("ipv6");
  if (boolChanged(news.monitoring, olds.monitoring)) changed.push("monitoring");
  if (news.userData !== olds.userData) changed.push("userData");
  if (news.vpcUuid !== olds.vpcUuid) changed.push("vpcUuid");
  // `undefined` means DigitalOcean's image default, which is not `false`.
  if (news.withDropletAgent !== olds.withDropletAgent) {
    changed.push("withDropletAgent");
  }
  if (!sameElements(news.sshKeys, olds.sshKeys)) changed.push("sshKeys");
  if (!sameElements(news.volumes, olds.volumes)) changed.push("volumes");
  return changed;
};

/** DigitalOcean reports no slug for older droplets; a slug then cannot be checked. */
const imageDrifted = (
  image: ImageSlug | number,
  droplet: DropletAttributes,
): boolean => {
  if (typeof image === "number") return droplet.imageId !== image;
  if (droplet.imageSlug === undefined) return false;
  return droplet.imageSlug !== image;
};

/**
 * Create-time props compared against the observed droplet. Used when no
 * previous props exist: adoption, or a create whose state was never saved.
 *
 * @internal exported for unit testing
 */
export const driftedImmutableProps = (
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

const isDuplicateTagError = (error: TagsCreateError): boolean =>
  error._tag === "BadRequest" && /exists/i.test(error.message);

const POLL: PollOptions = {
  every: "5 seconds",
  times: 60,
  timeout: "5 minutes",
};

export const DropletProvider = () =>
  Provider.effect(
    Droplet,
    Effect.gen(function* () {
      const create = yield* dropletsCreate;
      const get = yield* dropletsGet;
      const destroy = yield* dropletsDestroy;
      const list = yield* dropletsList;
      const postAction = yield* dropletActionsPost;
      const getAction = yield* dropletActionsGet;
      const createTag = yield* tagsCreate;
      const assignTag = yield* tagsAssignResources;
      const unassignTag = yield* tagsUnassignResources;

      const toAttrs = (droplet: ApiDroplet): DropletAttributes => ({
        dropletId: droplet.id,
        name: droplet.name,
        status: droplet.status,
        region: droplet.region.slug,
        sizeSlug: droplet.size_slug,
        imageId: droplet.image.id,
        imageSlug: droplet.image.slug ?? undefined,
        ipv4: droplet.networks.v4?.find((n) => n.type === "public")?.ip_address,
        privateIpv4: droplet.networks.v4?.find((n) => n.type === "private")
          ?.ip_address,
        ipv6: droplet.networks.v6?.find((n) => n.type === "public")?.ip_address,
        vpcUuid: droplet.vpc_uuid,
        features: droplet.features,
        tags: withoutOwnershipTags(droplet.tags),
        createdAt: droplet.created_at,
      });

      const observe = (dropletId: number) =>
        get({ droplet_id: dropletId }).pipe(
          Effect.map((r) => Option.some(r.droplet)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiDroplet>()),
          ),
        );

      /**
       * The ownership tag is unique per stack, stage and id, so a hit is
       * ours. `tag_name` also returns GPU droplets, which the plain list
       * hides behind `type=gpus`.
       */
      const observeOwnedByTag = (marker: string) =>
        list({ tag_name: marker, per_page: PAGE_SIZE }).pipe(
          Effect.map((r) => Arr.head(r.droplets ?? [])),
        );

      const observeByName = (name: string) =>
        list({ name, per_page: PAGE_SIZE }).pipe(
          Effect.map((r) => Arr.head(r.droplets ?? [])),
        );

      /**
       * A completed action can stay invisible to GET for up to a minute, so
       * every change is polled until observed. A 404 right after create is
       * the same read lag.
       */
      const waitForDroplet = (
        dropletId: number,
        settled: (droplet: ApiDroplet) => boolean,
      ) =>
        pollUntil(observe(dropletId), settled, {
          ...POLL,
          notSettled: (last) =>
            new DropletNotReady({
              dropletId,
              status: Option.match(last, {
                onNone: () => "missing",
                onSome: (droplet) => droplet.status,
              }),
            }),
        });

      /** Networking, and the IP we surface, exists once "active". */
      const waitForActive = (dropletId: number) =>
        waitForDroplet(dropletId, isActive);

      /** The action POST answers before the action ends. */
      const waitForActionComplete = Effect.fn(function* (
        dropletId: number,
        actionId: number,
      ) {
        const status = yield* pollUntil(
          getAction({ droplet_id: dropletId, action_id: actionId }).pipe(
            Effect.map(
              (r): Option.Option<string> => Option.some(r.action.status),
            ),
            Effect.catchTag("NotFound", () =>
              Effect.succeed(Option.some("in-progress")),
            ),
          ),
          (status) => status !== "in-progress",
          {
            ...POLL,
            notSettled: () =>
              new DropletActionFailed({
                dropletId,
                actionId,
                status: "timed-out",
              }),
          },
        );
        if (status !== "completed") {
          return yield* new DropletActionFailed({
            dropletId,
            actionId,
            status,
          });
        }
      });

      const dropletResource = (dropletId: number) => ({
        resources: [
          { resource_id: String(dropletId), resource_type: "droplet" },
        ],
      });

      /**
       * Tags diff against the observed tags, so adoption drops foreign
       * tags. The ownership tag is always desired. The assign endpoint
       * needs the tag to exist; a create that finds it already there is a
       * race, not an error.
       */
      const syncTags = Effect.fn(function* (
        droplet: ApiDroplet,
        userTags: string[] | undefined,
        marker: string,
      ) {
        const desired = [...new Set([...(userTags ?? []), marker])];
        const observed = droplet.tags;
        const toAdd = desired.filter((t) => !observed.includes(t));
        const toRemove = observed.filter((t) => !desired.includes(t));
        for (const tag of toAdd) {
          yield* createTag({ name: tag }).pipe(
            Effect.catchIf(isDuplicateTagError, () => Effect.void),
          );
          yield* assignTag({ tag_id: tag, ...dropletResource(droplet.id) });
        }
        for (const tag of toRemove) {
          yield* unassignTag({
            tag_id: tag,
            ...dropletResource(droplet.id),
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
        return toAdd.length > 0 || toRemove.length > 0;
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
        list: Effect.fn(function* () {
          // GPU droplets are only listed under `type=gpus`.
          const [plain, gpus] = yield* Effect.all(
            [
              listAllPages(
                (q) => list({ ...q, type: "droplets" }),
                (r) => r.droplets ?? [],
              ),
              listAllPages(
                (q) => list({ ...q, type: "gpus" }),
                (r) => r.droplets ?? [],
              ),
            ],
            { concurrency: 2 },
          );
          return [...plain, ...gpus].map(toAttrs);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const existing = yield* observe(output.dropletId);
            return Option.getOrUndefined(Option.map(existing, toAttrs));
          }
          const marker = yield* ownershipMarker(id);
          const owned = yield* observeOwnedByTag(marker);
          if (Option.isSome(owned)) return toAttrs(owned.value);
          // A same-named droplet without the tag is someone else's until
          // `--adopt` says otherwise.
          if (olds?.name === undefined) return undefined;
          const foreign = yield* observeByName(olds.name);
          return Option.getOrUndefined(
            Option.map(foreign, (droplet) => Unowned(toAttrs(droplet))),
          );
        }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const replace = { action: "replace", deleteFirst: true } as const;
          // An adopted droplet arrives with `news` as its `olds`; only the
          // observed droplet can show which create-time props differ.
          const hasPriorProps = olds !== undefined && olds !== news;
          if (!hasPriorProps) {
            if (output === undefined) return undefined;
            if (driftedImmutableProps(news, output).length > 0) return replace;
            return undefined;
          }
          if (output !== undefined && news.replaceAfter !== undefined) {
            const now = yield* Clock.currentTimeMillis;
            if (isOlderThan(output.createdAt, news.replaceAfter, now)) {
              return replace;
            }
          }
          if (changedImmutableProps(news, olds).length > 0) return replace;
          if (news.name !== olds.name || !sameElements(news.tags, olds.tags)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output }) {
          const marker = yield* ownershipMarker(id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }));

          // A create whose state was never saved is found again by its tag.
          const current = yield* output !== undefined
            ? observe(output.dropletId)
            : observeOwnedByTag(marker);

          if (Option.isNone(current)) {
            const created = yield* create({
              body: {
                name: desiredName,
                region: news.region,
                size: news.size,
                image: news.image,
                ssh_keys: news.sshKeys,
                backups: news.backups,
                ipv6: news.ipv6,
                monitoring: news.monitoring,
                tags: [...(news.tags ?? []), marker],
                user_data: news.userData,
                volumes: news.volumes,
                vpc_uuid: news.vpcUuid,
                with_droplet_agent: news.withDropletAgent,
              } satisfies DropletSingleCreateInput,
            });
            const dropletId = created.droplet?.id;
            if (dropletId === undefined) {
              return yield* new DropletCreateFailed({
                name: desiredName,
                reason: "create response carried no droplet",
              });
            }
            return toAttrs(yield* waitForActive(dropletId));
          }

          const droplet = current.value;
          const immutableChanges =
            olds === undefined
              ? driftedImmutableProps(news, toAttrs(droplet))
              : changedImmutableProps(news, olds);
          if (immutableChanges.length > 0) {
            return yield* new ReplacementRequired({
              resourceType: "DigitalOcean.Droplet",
              physicalId: String(droplet.id),
              properties: immutableChanges,
            });
          }

          const tagsChanged = yield* syncTags(droplet, news.tags, marker);
          const nameChanged = droplet.name !== desiredName;
          if (nameChanged) {
            yield* waitForDroplet(droplet.id, acceptsActions);
            const renamed = yield* postAction({
              droplet_id: droplet.id,
              body: {
                type: "rename",
                name: desiredName,
              } satisfies DropletActionRename,
            });
            yield* waitForActionComplete(droplet.id, renamed.action.id);
          }
          if (!tagsChanged && !nameChanged) return toAttrs(droplet);
          const settled = yield* waitForDroplet(
            droplet.id,
            (d) =>
              d.name === desiredName &&
              sameElements(withoutOwnershipTags(d.tags), news.tags),
          );
          return toAttrs(settled);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* destroy({ droplet_id: output.dropletId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          yield* pollUntilGone(observe(output.dropletId), {
            ...POLL,
            stillPresent: () =>
              new DropletStillPresent({ dropletId: output.dropletId }),
          });
        }),
      };
    }),
  );
