import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findOwnedByName,
  iaasName,
  labelsPatch,
  ownedOnly,
  projectScopeChanged,
  readGeneration,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

/** The create response of a snapshot carried no id. */
export class SnapshotIdMissing extends Data.TaggedError("Stackit.IaaS.SnapshotIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

export interface SnapshotProps extends ProjectScopedProps {
  /** Volume to snapshot. Changing it replaces the snapshot. */
  volumeId: string;
  /**
   * Name of the snapshot. Updated in place.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /** Free-text description. Updated in place; unmanaged when omitted. */
  description?: string;
  /**
   * Project of the snapshot (the volume's project). Defaults to the
   * profile's project. Changing it replaces the snapshot.
   */
  projectId?: string;
  /**
   * Region of the snapshot. Defaults to the profile's region. Changing it
   * replaces the snapshot.
   */
  region?: string;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface SnapshotAttributes {
  /** Snapshot id (UUID); use it as a volume `source` of type `snapshot`. */
  snapshotId: string;
  /** Volume the snapshot was taken of. */
  volumeId: string;
  /** Name of the snapshot. */
  name: string;
  /** Description. */
  description: string | undefined;
  /** Size in GB. */
  size: number | undefined;
  /** Availability zone of the snapshot (the volume's zone). */
  availabilityZone: string | undefined;
  /** Status, e.g. `AVAILABLE`. */
  status: string | undefined;
  /** Project of the snapshot. */
  projectId: string;
  /** Region of the snapshot. */
  region: string;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type Snapshot = Resource<
  "Stackit.IaaS.Snapshot",
  SnapshotProps,
  SnapshotAttributes,
  never,
  Providers
>;

/**
 * A point-in-time snapshot of a STACKIT volume, stored next to the volume
 * in the same availability zone. Restore it by creating a volume with
 * `source: { type: "snapshot", id }`, or turn it into an off-volume copy
 * with `Stackit.IaaS.Backup`.
 *
 * The snapshot content is fixed at creation; name, description and labels
 * update in place. A volume with snapshots cannot be deleted, so the
 * snapshot is deleted before its volume.
 *
 * ### Taking a snapshot
 * **Example:** Snapshot a data volume
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const data = yield* Stackit.IaaS.Volume("Data", { size: 20 });
 * const snapshot = yield* Stackit.IaaS.Snapshot("BeforeUpgrade", {
 *   volumeId: data.volumeId,
 *   description: "state before the v2 migration",
 * });
 * ```
 *
 * ### Replacement
 * Changing `volumeId`, `projectId` or `region` takes a new snapshot and
 * deletes the old one. Content is never refreshed in place: to take a new
 * snapshot of the same volume, change the logical id.
 *
 * @resource
 * @product STACKIT Block Storage
 * @category IaaS
 */
export const Snapshot = Resource<Snapshot>("Stackit.IaaS.Snapshot");

const READY_TIMEOUT = "10 minutes";

const isReady = (snapshot: iaas.Snapshot) => snapshot.status === "AVAILABLE";

const hasFailed = (snapshot: iaas.Snapshot) =>
  snapshot.status === "ERROR" ? snapshot.status : undefined;

const toAttrs = (
  snapshot: iaas.Snapshot,
  scope: ProjectScope,
  name: string,
): SnapshotAttributes => ({
  snapshotId: snapshot.id ?? "",
  volumeId: snapshot.volumeId,
  name: snapshot.name ?? name,
  description: snapshot.description,
  size: snapshot.size,
  availabilityZone: snapshot.availabilityZone,
  status: snapshot.status,
  ...scope,
  labels: stripInternalLabels(snapshot.labels),
});

const getSnapshot = (scope: ProjectScope, snapshotId: string) =>
  iaas
    .getSnapshot({ ...scope, snapshotId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const observe = Effect.fn(function* (args: {
  id: string;
  name: string;
  scope: ProjectScope;
  snapshotId: string | undefined;
  volumeId: string | undefined;
  instanceId: string | undefined;
}) {
  if (args.snapshotId !== undefined) {
    const byId = yield* getSnapshot(args.scope, args.snapshotId);
    if (byId !== undefined) return byId;
  }
  // Crash recovery: a create whose state was never persisted.
  const { items } = yield* iaas.listSnapshotsInProject(args.scope);
  return yield* findOwnedByName(args.id, args.name, items, {
    instanceId: args.instanceId,
    compatible: (snapshot) => args.volumeId === undefined || snapshot.volumeId === args.volumeId,
  });
});

export const SnapshotProvider = () =>
  Provider.succeed(Snapshot, {
    stables: ["snapshotId", "volumeId", "projectId", "region", "availabilityZone"],
    nuke: { dependsOn: ["Stackit.IaaS.Volume"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listSnapshotsInProject(scope);
      return ownedOnly(items).map((snapshot) => toAttrs(snapshot, scope, snapshot.name ?? ""));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (hasUnresolvedTrigger<SnapshotProps>(news, ["projectId", "region", "volumeId"])) {
        return { action: "replace" } as const;
      }
      const resolved = triggerProps<SnapshotProps>(news);
      if (yield* projectScopeChanged(resolved, output)) return { action: "replace" } as const;
      if (resolved.volumeId !== output.volumeId) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe({
        id,
        name,
        scope,
        snapshotId: output?.snapshotId,
        volumeId: olds?.volumeId,
        instanceId: readGeneration({ instanceId, output, previous }),
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope, name);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      // Observe — a recorded snapshot only counts for the same volume.
      const recordedId = output?.volumeId === news.volumeId ? output.snapshotId : undefined;
      let current = yield* observe({
        id,
        name,
        scope,
        snapshotId: recordedId,
        volumeId: news.volumeId,
        instanceId,
      });

      // Ensure — create when missing; `Conflict` while the volume is busy.
      if (current === undefined) {
        current = yield* iaas
          .createSnapshot({
            ...scope,
            volumeId: news.volumeId,
            name,
            description: news.description,
            labels,
          })
          .pipe(Effect.retry(conflictRetry));
      }
      const snapshotId = current.id;
      if (snapshotId === undefined) {
        return yield* new SnapshotIdMissing({
          resourceName: name,
          message: `STACKIT returned snapshot ${name} without an id`,
        });
      }
      let observed = isReady(current)
        ? current
        : yield* waitFor({
            resource: `STACKIT snapshot ${name}`,
            read: iaas.getSnapshot({ ...scope, snapshotId }),
            ready: isReady,
            failed: hasFailed,
            state: (snapshot) => snapshot.status,
            timeout: READY_TIMEOUT,
          });

      // Sync — name, description and labels.
      const patch: Omit<iaas.UpdateSnapshotRequest, "projectId" | "region" | "snapshotId"> = {};
      if (observed.name !== name) patch.name = name;
      if (news.description !== undefined && observed.description !== news.description) {
        patch.description = news.description;
      }
      const labelPatch = labelsPatch(observed.labels, labels);
      if (labelPatch !== undefined) patch.labels = labelPatch;
      if (Object.keys(patch).length > 0) {
        observed = yield* iaas.updateSnapshot({ ...scope, snapshotId, ...patch });
      }
      return toAttrs({ ...observed, id: snapshotId }, scope, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .deleteSnapshot({ ...scope, snapshotId: output.snapshotId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT snapshot ${output.name}`,
        read: getSnapshot(scope, output.snapshotId),
        state: (snapshot) => snapshot.status,
        timeout: "5 minutes",
      });
    }),
  });
