import * as DO from "@distilled.cloud/digitalocean";
import type { VolumeFull } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
import {
  alchemyTagsFor,
  deleteTagsIfUnused,
  desiredTagsFor,
  rejectReservedTags,
  syncTags,
} from "./internal/tags.ts";
import type { Providers } from "./Providers.ts";
import type { RegionSlug } from "./Slugs.ts";

export type VolumeFilesystemType = "ext4" | "xfs";

export type VolumeProps = {
  /**
   * Volume name, unique within the region. Lowercase letters, digits and
   * `-`, starting with a letter, at most 64 characters. A change replaces
   * the volume.
   *
   * @default a generated physical name
   */
  name?: string;

  /** Region slug. A volume attaches only to droplets in its region. A change replaces the volume. */
  region: RegionSlug;

  /**
   * Size in GiB. Growing the volume resizes it in place; the filesystem on
   * it is not grown for you. Shrinking replaces the volume, because
   * DigitalOcean cannot shrink one.
   */
  sizeGigabytes: number;

  /** Free-form description. A change replaces the volume. */
  description?: string;

  /**
   * Format the volume with this filesystem at create. A change replaces the
   * volume.
   *
   * @default unformatted
   */
  filesystemType?: VolumeFilesystemType;

  /** Label for the filesystem, when `filesystemType` is set. A change replaces the volume. */
  filesystemLabel?: string;

  /** Create the volume from this volume snapshot id. A change replaces the volume. */
  snapshotId?: string;

  /**
   * Tags to assign. Missing tags are created. A change updates the volume
   * in place. The `alchemy:` prefix is reserved.
   */
  tags?: string[];
};

export type Volume = Resource<
  "DigitalOcean.Volume",
  VolumeProps,
  {
    /** Volume id (UUID). */
    volumeId: string;
    /** Uniform resource name, `do:volume:<id>`, for `ProjectResources`. */
    urn: string;
    /** Volume name. */
    name: string;
    /** Region slug. */
    region: string;
    /** Size in GiB. */
    sizeGigabytes: number;
    /** Description, when one is set. */
    description: string | undefined;
    /** Filesystem the volume was formatted with, when one was requested. */
    filesystemType: string | undefined;
    /** Filesystem label, when one was set. */
    filesystemLabel: string | undefined;
    /** Ids of the droplets the volume is attached to. */
    dropletIds: number[];
    /** Tags without the `alchemy:` tags. */
    tags: string[];
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type VolumeAttributes = Volume["Attributes"];

/**
 * A DigitalOcean Block Storage Volume: a network disk that attaches to one
 * droplet in the same region. Growing `sizeGigabytes` and changing `tags`
 * update the volume in place; any other change replaces it, which loses
 * its data, so take a snapshot first.
 *
 * Alchemy tags every volume it creates with an `alchemy:` ownership tag
 * and an `alchemy:generation:` tag, so an interrupted deploy resumes on the
 * volume it already created. A same-named volume without the ownership tag
 * is `Unowned` and needs `--adopt`.
 *
 * ### Creating a Volume
 * **Example:** A formatted volume
 * ```typescript
 * const data = yield* DigitalOcean.Volume("data", {
 *   region: "sfo3",
 *   sizeGigabytes: 100,
 *   filesystemType: "ext4",
 * });
 * ```
 *
 * **Example:** Restore from a snapshot
 * ```typescript
 * const restored = yield* DigitalOcean.Volume("restored", {
 *   region: "sfo3",
 *   sizeGigabytes: 100,
 *   snapshotId: "3f1b8a8e-2c1f-11ef-9c3b-0a58ac14a0e5",
 * });
 * ```
 *
 * ### Attaching to a Droplet
 * **Example:** Attach a volume to a droplet
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 * });
 * const data = yield* DigitalOcean.Volume("data", {
 *   region: "sfo3",
 *   sizeGigabytes: 50,
 *   filesystemType: "ext4",
 * });
 * yield* DigitalOcean.VolumeAttachment("data-on-app", {
 *   volumeId: data.volumeId,
 *   dropletId: host.dropletId,
 * });
 * ```
 *
 * ### Growing a Volume
 * **Example:** Resize in place
 * ```typescript
 * // Raising sizeGigabytes from 50 resizes the volume without replacing it.
 * const data = yield* DigitalOcean.Volume("data", {
 *   region: "sfo3",
 *   sizeGigabytes: 200,
 *   filesystemType: "ext4",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Block-Storage
 *
 * @resource
 * @product Volumes
 * @category Storage
 */
export const Volume = Resource<Volume>("DigitalOcean.Volume");

export class VolumeTagReserved extends Data.TaggedError("DigitalOcean.VolumeTagReserved")<{
  readonly tag: string;
}> {
  override get message() {
    return `Tag '${this.tag}' uses the 'alchemy:' prefix, which is reserved for ownership tags.`;
  }
}

export class VolumeActionFailed extends Data.TaggedError("DigitalOcean.VolumeActionFailed")<{
  readonly volumeId: string;
  readonly actionId: number;
  readonly status: string;
}> {
  override get message() {
    return `Volume ${this.volumeId} action ${this.actionId} did not complete (last status: '${this.status}').`;
  }
}

export class VolumeWaitTimedOut extends Data.TaggedError("DigitalOcean.VolumeWaitTimedOut")<{
  readonly volumeId: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `Volume ${this.volumeId} timed out waiting for ${this.waitingFor}.`;
  }
}

const NAME_MAX_LENGTH = 64;

const PAGE_SIZE = 200;

// A resize or a detach finishes within seconds; a busy region can take a minute.
const ACTION_POLL: PollBudget = { maxDelay: "5 seconds", times: 30 };

// GET lags a change by a few seconds.
const VOLUME_POLL: PollBudget = { maxDelay: "3 seconds", times: 20 };

const REPLACING_VALUES = [
  "name",
  "region",
  "description",
  "filesystemType",
  "filesystemLabel",
  "snapshotId",
] as const;

// The API reports the filesystem only once the volume is formatted, so the
// requested one stands in until then.
const toAttrs = (volume: VolumeFull, requested?: VolumeProps): VolumeAttributes => ({
  volumeId: volume.id,
  urn: `do:volume:${volume.id}`,
  name: volume.name,
  region: volume.region.slug,
  sizeGigabytes: volume.size_gigabytes,
  description: volume.description || undefined,
  filesystemType: volume.filesystem_type || requested?.filesystemType,
  filesystemLabel: volume.filesystem_label || requested?.filesystemLabel,
  dropletIds: [...(volume.droplet_ids ?? [])],
  tags: withoutAlchemyTags(volume.tags ?? []),
  createdAt: volume.created_at,
});

const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: NAME_MAX_LENGTH });

const observeById = (volumeId: string) =>
  noneIfNotFound(DO.getVolume({ volume_id: volumeId }).pipe(Effect.map((r) => r.volume)));

const observeByName = (name: string, region: string) =>
  DO.listVolumes.items({ name, region, per_page: PAGE_SIZE }).pipe(Stream.runHead);

// The stored id is a cache. The name finds the volume without it, and its
// generation tag tells this generation from a replaced one.
const observeGeneration = Effect.fn(function* (
  output: VolumeAttributes | undefined,
  name: string,
  region: string,
  instanceId: string,
) {
  if (output !== undefined) {
    const byId = yield* observeById(output.volumeId);
    if (Option.isSome(byId)) return byId;
  }
  const byName = yield* observeByName(name, region);
  return Option.filter(byName, (volume) =>
    (volume.tags ?? []).includes(generationTagFor(instanceId)),
  );
});

const observeActionStatus = (volumeId: string, actionId: number) =>
  DO.getVolumeAction({ volume_id: volumeId, action_id: actionId }).pipe(
    Effect.map((response) => response.action.status),
    // A 404 on a new action is read lag.
    Effect.catchTag("NotFound", () => Effect.succeed("in-progress" as const)),
  );

const runVolumeAction = Effect.fn(function* (
  volumeId: string,
  body: DO.PostVolumeActionByIdRequestBody,
) {
  const posted = yield* DO.postVolumeActionById({ volume_id: volumeId, body });
  const actionId = posted.action.id;
  const failed = (status: string) => new VolumeActionFailed({ volumeId, actionId, status });
  yield* pollUntil(observeActionStatus(volumeId, actionId), {
    ...ACTION_POLL,
    until: (status) => status !== "in-progress",
    onTimeout: failed,
  }).pipe(Effect.filterOrFail((status) => status === "completed", failed));
});

const waitForVolume = (volumeId: string, waitingFor: string, until: (v: VolumeFull) => boolean) =>
  pollUntil(observeById(volumeId), {
    ...VOLUME_POLL,
    until: (observed): observed is Option.Some<VolumeFull> =>
      Option.isSome(observed) && until(observed.value),
    onTimeout: () => new VolumeWaitTimedOut({ volumeId, waitingFor }),
  }).pipe(Effect.map((observed) => observed.value));

const waitUntilGone = (volumeId: string) =>
  pollUntil(observeById(volumeId), {
    ...VOLUME_POLL,
    until: Option.isNone,
    onTimeout: () => new VolumeWaitTimedOut({ volumeId, waitingFor: "deletion" }),
  });

const createVolume = Effect.fn(function* (
  name: string,
  news: VolumeProps,
  tags: ReadonlyArray<string>,
) {
  const created = yield* DO.createVolume({
    body: {
      name,
      region: news.region,
      size_gigabytes: news.sizeGigabytes,
      description: news.description,
      filesystem_type: news.filesystemType,
      filesystem_label: news.filesystemLabel,
      snapshot_id: news.snapshotId,
      tags: [...tags],
    },
  });
  return created.volume;
});

const syncSize = Effect.fn(function* (volume: VolumeFull, sizeGigabytes: number) {
  if (volume.size_gigabytes >= sizeGigabytes) return;
  yield* runVolumeAction(volume.id, {
    type: "resize",
    region: volume.region.slug,
    size_gigabytes: sizeGigabytes,
  });
});

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: ["volumeId", "urn", "name", "region", "createdAt"],
    list: Effect.fn(function* () {
      const volumes = yield* DO.listVolumes.items({ per_page: PAGE_SIZE }).pipe(Stream.runCollect);
      return volumes
        .filter((volume) => (volume.tags ?? []).some(isAlchemyTag))
        .map((volume) => toAttrs(volume));
    }),
    read: Effect.fn(function* ({ id, fqn, instanceId, olds, output }) {
      const name = olds.name ?? (yield* physicalName(id));
      const owned = yield* observeGeneration(output, name, olds.region, instanceId);
      if (Option.isSome(owned)) return toAttrs(owned.value, olds);
      if (olds.name === undefined) return undefined;
      // A chosen name that a volume without this resource's ownership tag
      // holds belongs to someone else.
      const ownershipTag = yield* ownershipTagFor(fqn);
      const named = yield* observeByName(olds.name, olds.region);
      return named.pipe(
        Option.filter((volume) => !(volume.tags ?? []).includes(ownershipTag)),
        Option.map((volume) => Unowned(toAttrs(volume))),
        Option.getOrUndefined,
      );
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      const changed =
        REPLACING_VALUES.some((prop) => news[prop] !== olds[prop]) ||
        news.sizeGigabytes < olds.sizeGigabytes;
      // Names are unique within a region, so a chosen name frees up before
      // the new volume takes it.
      if (changed) return { action: "replace", deleteFirst: news.name !== undefined } as const;
    }),
    reconcile: Effect.fn(function* ({ id, fqn, instanceId, news, output }) {
      yield* rejectReservedTags(news.tags, (tag) => new VolumeTagReserved({ tag }));
      const tags = yield* desiredTagsFor(news.tags, fqn, instanceId);
      const name = news.name ?? (yield* physicalName(id));

      const observed = yield* observeGeneration(output, name, news.region, instanceId);
      const volume = yield* Option.match(observed, {
        onNone: () => createVolume(name, news, tags),
        onSome: Effect.succeed,
      });

      yield* syncTags("volume", volume.id, volume.tags ?? [], tags);
      yield* syncSize(volume, news.sizeGigabytes);
      return toAttrs(
        yield* waitForVolume(
          volume.id,
          "its size and tags",
          (v) => v.size_gigabytes >= news.sizeGigabytes && setEquals(v.tags, tags),
        ),
        news,
      );
    }),
    delete: Effect.fn(function* ({ fqn, instanceId, output }) {
      const observed = yield* observeById(output.volumeId);
      const alchemyTags = Option.isSome(observed)
        ? (observed.value.tags ?? []).filter(isAlchemyTag)
        : yield* alchemyTagsFor(fqn, instanceId);
      if (Option.isSome(observed)) {
        yield* ignoreNotFound(DO.deleteVolume({ volume_id: output.volumeId }));
        yield* waitUntilGone(output.volumeId);
      }
      yield* deleteTagsIfUnused(alchemyTags);
    }),
  });
