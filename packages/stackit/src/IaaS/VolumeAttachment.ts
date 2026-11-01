import * as iaas from "@distilled.cloud/stackit/iaas";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
 * volume and attaches the new pair. Unmount the device in the guest first:
 * a detach under I/O can lose writes.
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

const getVolumeStatus = (scope: ProjectScope, volumeId: string) =>
  iaas.getVolume({ ...scope, volumeId }).pipe(
    Effect.map((volume) => volume.status),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const VolumeAttachmentProvider = () =>
  Provider.succeed(VolumeAttachment, {
    stables: ["serverId", "volumeId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.Server", "Stackit.IaaS.Volume"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      if (news.serverId !== output.serverId || news.volumeId !== output.volumeId) {
        return { action: "replace" } as const;
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
        yield* waitFor({
          resource: `STACKIT volume ${ids.volumeId} on server ${ids.serverId}`,
          read: getVolumeStatus(scope, ids.volumeId),
          ready: (status) => status === "ATTACHED",
          failed: (status) => (status === "ERROR" ? status : undefined),
          state: (status) => status,
          timeout: "5 minutes",
        });
      }

      // Sync — the only mutable aspect.
      if ((current.deleteOnTermination ?? false) !== deleteOnTermination) {
        current = yield* iaas.updateAttachedVolume({ ...scope, ...ids, deleteOnTermination });
      }
      return toAttrs(current, scope, ids);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
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
      // Gone once the attachment is unknown and the volume finished
      // detaching (or no longer exists).
      yield* waitUntilGone({
        resource: `STACKIT volume ${output.volumeId} on server ${output.serverId}`,
        read: Effect.gen(function* () {
          const attachment = yield* getAttachment(scope, output.serverId, output.volumeId);
          const status = yield* getVolumeStatus(scope, output.volumeId);
          return attachment === undefined && (status === undefined || status === "AVAILABLE")
            ? undefined
            : (status ?? "ATTACHED");
        }),
        state: (status) => status,
        timeout: "5 minutes",
      });
    }),
  });
