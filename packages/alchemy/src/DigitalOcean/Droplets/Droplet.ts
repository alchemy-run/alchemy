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
} from "@distilled.cloud/digitalocean/tags";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { sameElements } from "../../Util/equal.ts";
import { listAllPages } from "../paginate.ts";
import type { Providers } from "../Providers.ts";

export type DropletProps = {
  /**
   * Droplet name (also its hostname). Defaults to a generated physical
   * name. Renames in place.
   */
  name?: string;
  /** Region slug to deploy into, e.g. `sfo3`, `nyc1`. Replaces. */
  region: string;
  /** Size slug, e.g. `s-1vcpu-1gb`, `s-2vcpu-4gb`. Replaces. */
  size: string;
  /** Public image slug (`ubuntu-24-04-x64`) or private image id. Replaces. */
  image: string | number;
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
   * Maximum droplet age before a deploy replaces it, as millis or a
   * duration string (`"30 days"`); both serialize into state. Age is
   * measured from the droplet's
   * `createdAt`: once exceeded, the next deploy rebuilds the host on a
   * fresh image — phoenix-style patching
   * (https://martinfowler.com/bliki/PhoenixServer.html). The replacement
   * changes the public IP. Changing the policy itself never triggers a
   * replace; only crossing the age horizon does.
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
    tags: string[];
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A DigitalOcean Droplet — a Linux virtual machine. `name` and `tags` sync
 * in place; every other property replaces the droplet (delete-first, since
 * the name is its hostname). Provision via `userData` (cloud-init) so a
 * replacement converges on its own.
 *
 * Ownership: droplet names are not unique, so alchemy stamps an
 * `alchemy:{stack}:{stage}:{id}` tag at create. A wiped state store
 * recovers the droplet through that tag; a same-named droplet without it
 * surfaces as `Unowned` and requires `--adopt`.
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

/** Tag charset: letters/numbers/colons/dashes/underscores, ≤255 chars. */
const OWNERSHIP_TAG_PREFIX = "alchemy:";

const sanitizeTagPart = (part: string) =>
  part.replaceAll(/[^a-zA-Z0-9_-]/g, "-");

const ownershipTag = (stack: string, stage: string, id: string) =>
  `${OWNERSHIP_TAG_PREFIX}${[stack, stage, id]
    .map(sanitizeTagPart)
    .join(":")}`.slice(0, 255);

const withoutOwnershipTags = (tags: readonly string[]) =>
  tags.filter((t) => !t.startsWith(OWNERSHIP_TAG_PREFIX));

class DropletNotReady extends Data.TaggedError("DropletNotReady")<{
  readonly dropletId: number;
  readonly status: string;
}> {}

class DropletStillPresent extends Data.TaggedError("DropletStillPresent")<{
  readonly dropletId: number;
}> {}

class DropletActionFailed extends Data.TaggedError("DropletActionFailed")<{
  readonly dropletId: number;
  readonly actionId: number;
  readonly status: string;
}> {}

class DropletCreateFailed extends Data.TaggedError("DropletCreateFailed")<{
  readonly name: string;
  readonly reason: string;
}> {}

class DropletReplacementRequired extends Data.TaggedError(
  "DropletReplacementRequired",
)<{
  readonly dropletId: number;
  readonly drifted: readonly string[];
}> {}

const isSettled = (droplet: ApiDroplet) =>
  droplet.status === "active" && !droplet.locked;

/**
 * `replaceAfter` horizon. A malformed `createdAt` parses to NaN and is
 * treated as not due.
 */
const isPastReplaceHorizon = (
  createdAt: string,
  age: number | (Duration.Input & string),
  nowMs: number,
): boolean => nowMs - new Date(createdAt).getTime() >= Duration.toMillis(age);

/**
 * Immutable props checkable against observed state. A change here can
 * reach `reconcile` without a `replace` plan (the converge pass re-runs
 * reconcile on late-resolved Outputs without re-running diff); applying it
 * in place is impossible, so reconcile must fail loudly instead of
 * silently committing props that were never applied. Failing self-heals:
 * props aren't persisted on failure, and the next plan — now resolved —
 * classifies the change as `replace`.
 */
const driftedImmutableProps = (
  droplet: ApiDroplet,
  news: DropletProps,
): string[] => {
  const drifted: string[] = [];
  if (droplet.region.slug !== news.region) drifted.push("region");
  if (droplet.size_slug !== news.size) drifted.push("size");
  if (
    typeof news.image === "number"
      ? droplet.image.id !== news.image
      : droplet.image.slug !== news.image
  ) {
    drifted.push("image");
  }
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
  if (news.vpcUuid !== undefined && droplet.vpc_uuid !== news.vpcUuid) {
    drifted.push("vpcUuid");
  }
  return drifted;
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

      const toAttrs = (droplet: ApiDroplet) => ({
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
       * The ownership tag is unique per stack/stage/id, so a hit is ours by
       * construction. `tag_name` also sidesteps the list API's GPU-droplet
       * exclusion (GPU droplets only appear under `type=gpus`). Replacement
       * is delete-first (see diff), so a stale prior generation can never
       * satisfy this probe.
       */
      const observeOwnedByTag = (marker: string) =>
        list({ tag_name: marker, per_page: 200 }).pipe(
          Effect.map((r) => Arr.head(r.droplets ?? [])),
        );

      const observeByName = (name: string) =>
        list({ name, per_page: 200 }).pipe(
          Effect.map((r) => Arr.head(r.droplets ?? [])),
        );

      /**
       * Droplet reads are eventually consistent after actions (a completed
       * rename stays invisible to GET for ~30-60s, verified live), so
       * anything a mutation changes is polled until observed, never assumed
       * from action completion. Polling runs on the success channel;
       * `DropletNotReady` is only the terminal timeout. A 404 right after
       * the 202 create is the same read lag — folded into "not yet".
       */
      const waitForDroplet = (
        dropletId: number,
        settled: (droplet: ApiDroplet) => boolean,
      ) =>
        get({ droplet_id: dropletId }).pipe(
          Effect.map((r) => Option.some(r.droplet)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiDroplet>()),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (droplet) => Option.exists(droplet, settled),
            times: 120,
          }),
          // Exhausting `times` still returns the last value as a success —
          // re-check before conceding.
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new DropletNotReady({ dropletId, status: "missing" }),
                ),
              onSome: (droplet) =>
                settled(droplet)
                  ? Effect.succeed(droplet)
                  : Effect.fail(
                      new DropletNotReady({
                        dropletId,
                        status: droplet.status,
                      }),
                    ),
            }),
          ),
          // Hard wall-clock bound: the SDK's default retry nests under each
          // poll tick, so iteration count alone doesn't bound time.
          Effect.timeoutOrElse({
            duration: "15 minutes",
            orElse: () =>
              new DropletNotReady({ dropletId, status: "timed-out" }),
          }),
        );

      /**
       * Creation answers 202 with status "new"; networking (and the IP we
       * surface) only exists once "active". Locked droplets reject actions.
       */
      const waitForActive = (dropletId: number) =>
        waitForDroplet(dropletId, isSettled);

      /**
       * Actions are asynchronous — the POST answers an in-progress Action
       * while the droplet stays `active`, so polling the droplet proves
       * nothing. Anything but "completed" is terminal.
       */
      const waitForActionComplete = (dropletId: number, actionId: number) =>
        getAction({ droplet_id: dropletId, action_id: actionId }).pipe(
          Effect.map((r) => r.action.status),
          Effect.catchTag("NotFound", () =>
            Effect.succeed("in-progress" as const),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (status): boolean => status !== "in-progress",
            times: 60,
          }),
          Effect.flatMap((status) =>
            status === "completed"
              ? Effect.void
              : Effect.fail(
                  new DropletActionFailed({ dropletId, actionId, status }),
                ),
          ),
          Effect.timeoutOrElse({
            duration: "10 minutes",
            orElse: () =>
              new DropletActionFailed({
                dropletId,
                actionId,
                status: "timed-out",
              }),
          }),
        );

      const dropletResource = (dropletId: number) => ({
        resources: [
          { resource_id: String(dropletId), resource_type: "droplet" },
        ],
      });

      /**
       * Tags diff against observed cloud tags (adoption may bring foreign
       * tags), with the ownership tag always in the desired set — this is
       * also what brands a freshly adopted droplet. The assign endpoint
       * requires the tag to exist; BadRequest on create is the
       * already-exists race.
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
            Effect.catchTag("BadRequest", () => Effect.void),
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
          // GPU droplets only appear under `type=gpus` — enumerate both
          // classes or `nuke` never sees them.
          const [plain, gpus] = yield* Effect.all([
            listAllPages((q) =>
              list({ ...q, type: "droplets" }).pipe(
                Effect.map((r) => r.droplets ?? []),
              ),
            ),
            listAllPages((q) =>
              list({ ...q, type: "gpus" }).pipe(
                Effect.map((r) => r.droplets ?? []),
              ),
            ),
          ]);
          return [...plain, ...gpus].map(toAttrs);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const stack = yield* Stack;
          const stage = yield* Stage;
          const marker = ownershipTag(stack.name, stage, id);
          if (output !== undefined) {
            const existing = yield* observe(output.dropletId);
            return Option.getOrUndefined(Option.map(existing, toAttrs));
          }
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
          // The age horizon fires before the olds bail so it covers
          // adopted droplets too, and reads the clock effectfully so plans
          // are testable.
          if (output !== undefined && news.replaceAfter !== undefined) {
            const now = yield* Clock.currentTimeMillis;
            if (
              isPastReplaceHorizon(output.createdAt, news.replaceAfter, now)
            ) {
              return { action: "replace", deleteFirst: true } as const;
            }
          }
          if (olds === undefined) return undefined;
          const boolChanged = (
            a: boolean | undefined,
            b: boolean | undefined,
          ) => (a ?? false) !== (b ?? false);
          // Create-time-only props. Delete-first: the name is a hostname,
          // and it keeps the ownership-tag probe generation-unambiguous.
          if (
            news.region !== olds.region ||
            news.size !== olds.size ||
            news.image !== olds.image ||
            boolChanged(news.backups, olds.backups) ||
            boolChanged(news.ipv6, olds.ipv6) ||
            boolChanged(news.monitoring, olds.monitoring) ||
            news.userData !== olds.userData ||
            news.vpcUuid !== olds.vpcUuid ||
            news.withDropletAgent !== olds.withDropletAgent ||
            !sameElements(news.sshKeys, olds.sshKeys) ||
            !sameElements(news.volumes, olds.volumes)
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
          if (news.name !== olds.name || !sameElements(news.tags, olds.tags)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const stack = yield* Stack;
          const stage = yield* Stage;
          const marker = ownershipTag(stack.name, stage, id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }));

          // Observe — cached id first, then the ownership tag, so a crash
          // after create (state never persisted) converges instead of
          // minting a twin. The tag proves ownership; a same-named foreign
          // droplet can never satisfy this probe.
          const current = yield* output !== undefined
            ? observe(output.dropletId)
            : observeOwnedByTag(marker);

          // Ensure
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
          const drifted = driftedImmutableProps(droplet, news);
          if (drifted.length > 0) {
            return yield* new DropletReplacementRequired({
              dropletId: droplet.id,
              drifted,
            });
          }

          // Sync
          const tagsChanged = yield* syncTags(droplet, news.tags, marker);
          if (droplet.name !== desiredName) {
            yield* waitForActive(droplet.id);
            const renamed = yield* postAction({
              droplet_id: droplet.id,
              body: {
                type: "rename",
                name: desiredName,
              } satisfies DropletActionRename,
            });
            yield* waitForActionComplete(droplet.id, renamed.action.id);
            // Action completion is not read visibility.
            return toAttrs(
              yield* waitForDroplet(
                droplet.id,
                (d) => isSettled(d) && d.name === desiredName,
              ),
            );
          }
          return tagsChanged
            ? toAttrs(
                yield* waitForDroplet(droplet.id, (d) =>
                  sameElements(withoutOwnershipTags(d.tags), news.tags),
                ),
              )
            : toAttrs(droplet);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* destroy({ droplet_id: output.dropletId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          // Destruction is async — poll until NotFound so a follow-up
          // create never observes the dying instance.
          const gone = yield* get({ droplet_id: output.dropletId }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (gone) => gone,
              times: 60,
            }),
            Effect.timeoutOrElse({
              duration: "10 minutes",
              orElse: () => Effect.succeed(false),
            }),
          );
          if (!gone) {
            return yield* new DropletStillPresent({
              dropletId: output.dropletId,
            });
          }
        }),
      };
    }),
  );
