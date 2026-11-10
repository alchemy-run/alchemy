import * as DO from "@distilled.cloud/digitalocean";
import type { VolumeFull } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type VolumeAttachmentProps = {
  /** Volume to attach. A change replaces the attachment. */
  volumeId: string;
  /** Droplet in the volume's region. A change replaces the attachment. */
  dropletId: number;
};

export type VolumeAttachment = Resource<
  "DigitalOcean.VolumeAttachment",
  VolumeAttachmentProps,
  {
    /** Attached volume id. */
    volumeId: string;
    /** Droplet the volume is attached to. */
    dropletId: number;
    /** Region slug of the volume and the droplet. */
    region: string;
  },
  never,
  Providers
>;

/**
 * Attaches a Block Storage Volume to a droplet. Destroying the attachment
 * detaches the volume; the volume and its data stay. A volume attaches to
 * one droplet at a time, and both must be in the same region.
 *
 * The volume appears in the droplet as `/dev/disk/by-id/scsi-0DO_Volume_<name>`.
 * Mount it from the droplet's cloud-init or your own configuration.
 *
 * ### Attaching a Volume
 * **Example:** Attach a data volume to a droplet
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
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/volumeActions_post_byId
 *
 * @resource
 * @product Volumes
 * @category Storage
 */
export const VolumeAttachment = Resource<VolumeAttachment>("DigitalOcean.VolumeAttachment");

export class VolumeAttachmentFailed extends Data.TaggedError(
  "DigitalOcean.VolumeAttachmentFailed",
)<{
  readonly volumeId: string;
  readonly dropletId: number;
  readonly waitingFor: "attach" | "detach";
}> {
  override get message() {
    return `Volume ${this.volumeId} did not ${this.waitingFor} ${this.waitingFor === "attach" ? "to" : "from"} droplet ${this.dropletId} in time.`;
  }
}

// An attach or detach finishes within seconds; a droplet that is still
// booting can hold it for a minute.
const ATTACH_POLL: PollBudget = { maxDelay: "5 seconds", times: 30 };

const observeVolume = (volumeId: string) =>
  noneIfNotFound(DO.getVolume({ volume_id: volumeId }).pipe(Effect.map((r) => r.volume)));

const isAttachedTo = (dropletId: number) => (volume: VolumeFull) =>
  (volume.droplet_ids ?? []).includes(dropletId);

const waitForAttachment = (volumeId: string, dropletId: number, waitingFor: "attach" | "detach") =>
  pollUntil(observeVolume(volumeId), {
    ...ATTACH_POLL,
    until: (observed) =>
      waitingFor === "attach"
        ? Option.exists(observed, isAttachedTo(dropletId))
        : !Option.exists(observed, isAttachedTo(dropletId)),
    onTimeout: () => new VolumeAttachmentFailed({ volumeId, dropletId, waitingFor }),
  });

const postAction = (volumeId: string, body: DO.PostVolumeActionByIdRequestBody) =>
  DO.postVolumeActionById({ volume_id: volumeId, body });

export const VolumeAttachmentProvider = () =>
  Provider.succeed(VolumeAttachment, {
    stables: ["volumeId", "dropletId", "region"],
    read: Effect.fn(function* ({ olds, output }) {
      const volumeId = output?.volumeId ?? olds.volumeId;
      const dropletId = output?.dropletId ?? olds.dropletId;
      const volume = yield* observeVolume(volumeId);
      if (Option.isNone(volume) || !isAttachedTo(dropletId)(volume.value)) return undefined;
      return { volumeId, dropletId, region: volume.value.region.slug };
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      // A volume or droplet known only after deploy is a new one. A volume
      // attaches to one droplet at a time, so the old attachment goes first.
      if (!isResolved(news)) return { action: "replace", deleteFirst: true } as const;
      if (news.volumeId !== olds.volumeId || news.dropletId !== olds.dropletId) {
        return { action: "replace", deleteFirst: true } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news }) {
      // A missing volume fails with its typed NotFound.
      const { volume } = yield* DO.getVolume({ volume_id: news.volumeId });
      if (!isAttachedTo(news.dropletId)(volume)) {
        yield* postAction(news.volumeId, {
          type: "attach",
          droplet_id: news.dropletId,
          region: volume.region.slug,
        });
        yield* waitForAttachment(news.volumeId, news.dropletId, "attach");
      }
      return { volumeId: news.volumeId, dropletId: news.dropletId, region: volume.region.slug };
    }),
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* observeVolume(output.volumeId);
      if (Option.isNone(observed) || !isAttachedTo(output.dropletId)(observed.value)) return;
      yield* postAction(output.volumeId, {
        type: "detach",
        droplet_id: output.dropletId,
        region: output.region,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitForAttachment(output.volumeId, output.dropletId, "detach");
    }),
  });
