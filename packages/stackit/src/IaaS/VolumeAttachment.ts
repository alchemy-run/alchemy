import * as iaas from "@distilled.cloud/stackit/iaas";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

export interface VolumeAttachmentProps extends ProjectScopedProps {
  /** Server to attach the volume to. Changing it replaces the attachment. */
  serverId: string;
  /**
   * Volume to attach. It must be in the server's availability zone.
   * Changing it replaces the attachment.
   */
  volumeId: string;
  /**
   * Delete the volume when the server is deleted. Updated in place.
   * @default false
   */
  deleteOnTermination?: boolean;
  /**
   * Project of the server and volume. Defaults to the profile's project.
   * Changing it replaces the attachment.
   */
  projectId?: string;
  /**
   * Region of the server and volume. Defaults to the profile's region.
   * Changing it replaces the attachment.
   */
  region?: string;
}

export interface VolumeAttachmentAttributes {
  /** Server the volume is attached to. */
  serverId: string;
  /** Attached volume. */
  volumeId: string;
  /** Whether the volume is deleted with the server. */
  deleteOnTermination: boolean;
  /** Project of the attachment. */
  projectId: string;
  /** Region of the attachment. */
  region: string;
}

export type VolumeAttachment = Resource<
  "Stackit.IaaS.VolumeAttachment",
  VolumeAttachmentProps,
  VolumeAttachmentAttributes,
  never,
  Providers
>;

/**
 * Attaches a STACKIT volume to a server (hot-plug; the guest sees a new
 * block device).
 *
 * The attachment is identified by the server and volume ids; only
 * `deleteOnTermination` updates in place. Attachments carry no labels:
 * Alchemy tracks the attachment by the ids in state, and a deploy without
 * state takes over an existing attachment of the same pair.
 *
 * ### Attaching a data volume
 * **Example:** Attach a volume to a server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.2",
 *   availabilityZone: "eu01-1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const data = yield* Stackit.IaaS.Volume("DbData", {
 *   size: 100,
 *   availabilityZone: "eu01-1",
 * });
 * yield* Stackit.IaaS.VolumeAttachment("DbData", {
 *   serverId: server.serverId,
 *   volumeId: data.volumeId,
 * });
 * ```
 *
 * ### Replacement
 * Changing `serverId`, `volumeId`, `projectId` or `region` detaches the
 * volume first and then attaches the new pair, since a volume attaches to
 * one server at a time. Unmount the device in the guest first: a detach
 * under I/O can lose writes.
 *
 * @resource
 * @product STACKIT Block Storage
 * @category IaaS
 */
export const VolumeAttachment = Resource<VolumeAttachment>("Stackit.IaaS.VolumeAttachment");

const toAttrs = (
  attachment: iaas.VolumeAttachment,
  scope: ProjectScope,
  ids: { serverId: string; volumeId: string },
): VolumeAttachmentAttributes => ({
  serverId: attachment.serverId ?? ids.serverId,
  volumeId: attachment.volumeId ?? ids.volumeId,
  deleteOnTermination: attachment.deleteOnTermination ?? false,
  ...scope,
});

const getAttachment = (scope: ProjectScope, serverId: string, volumeId: string) =>
  iaas
    .getAttachedVolume({ ...scope, serverId, volumeId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const getVolumeOrUndefined = (scope: ProjectScope, volumeId: string) =>
  iaas.getVolume({ ...scope, volumeId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const VolumeAttachmentProvider = () =>
  Provider.succeed(VolumeAttachment, {
    stables: ["serverId", "volumeId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.Server", "Stackit.IaaS.Volume"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // A volume attaches to one server at a time, so a move detaches first.
      // Delete-first also covers an unresolved id that resolves to the same
      // pair: this pair has no generation marker, so a create-first
      // replacement would claim it and garbage collection would then detach it.
      if (
        hasUnresolvedTrigger<VolumeAttachmentProps>(news, [
          "projectId",
          "region",
          "serverId",
          "volumeId",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        (yield* projectScopeChanged(news, output)) ||
        news.serverId !== output.serverId ||
        news.volumeId !== output.volumeId
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // No ownership marker: without a recorded pair, reconcile takes over
      // an existing attachment instead.
      if (output === undefined) return undefined;
      const scope = { projectId: output.projectId, region: output.region };
      const observed = yield* getAttachment(scope, output.serverId, output.volumeId);
      return observed === undefined ? undefined : toAttrs(observed, scope, output);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const ids = { serverId: news.serverId, volumeId: news.volumeId };
      const deleteOnTermination = news.deleteOnTermination ?? false;

      // Observe.
      let current = yield* getAttachment(scope, ids.serverId, ids.volumeId);

      // Ensure — `Conflict` while the server or volume is still busy.
      if (current === undefined) {
        current = yield* iaas
          .addVolumeToServer({ ...scope, ...ids, deleteOnTermination })
          .pipe(Effect.retry(conflictRetry));
      }

      // Every path waits: a crash right after the attach call finds the
      // attachment on the next run with the volume still attaching.
      yield* waitFor({
        resource: `STACKIT volume ${ids.volumeId} on server ${ids.serverId}`,
        read: getVolumeOrUndefined(scope, ids.volumeId),
        ready: (volume) => volume?.status === "ATTACHED",
        failed: (volume) => (volume?.status === "ERROR" ? volume.status : undefined),
        state: (volume) => volume?.status,
        timeout: "5 minutes",
      });

      // Sync — the only mutable aspect.
      if ((current.deleteOnTermination ?? false) !== deleteOnTermination) {
        current = yield* iaas.updateAttachedVolume({ ...scope, ...ids, deleteOnTermination });
      }
      return toAttrs(current, scope, ids);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      // Observe first: a volume moved to another server has nothing to detach here.
      if ((yield* getAttachment(scope, output.serverId, output.volumeId)) !== undefined) {
        yield* iaas
          .removeVolumeFromServer({
            ...scope,
            serverId: output.serverId,
            volumeId: output.volumeId,
          })
          .pipe(
            Effect.retry(conflictRetry),
            Effect.catchTag("NotFound", () => Effect.void),
          );
      }
      // Gone once the attachment is unknown and the volume finished detaching,
      // no longer exists, or already belongs to another server.
      yield* waitUntilGone({
        resource: `STACKIT volume ${output.volumeId} on server ${output.serverId}`,
        read: Effect.gen(function* () {
          const attachment = yield* getAttachment(scope, output.serverId, output.volumeId);
          const volume = yield* getVolumeOrUndefined(scope, output.volumeId);
          if (attachment !== undefined) return volume?.status ?? "ATTACHED";
          if (volume === undefined || volume.status === "AVAILABLE") return undefined;
          if (volume.serverId !== undefined && volume.serverId !== output.serverId) {
            return undefined;
          }
          return volume.status ?? "DETACHING";
        }),
        state: (status) => status,
        timeout: "5 minutes",
      });
    }),
  });
