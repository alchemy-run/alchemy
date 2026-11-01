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

/** The create response of a backup carried no id. */
export class BackupIdMissing extends Data.TaggedError("Stackit.IaaS.BackupIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** What a backup copies. */
export interface BackupSource {
  /** Back up a volume (STACKIT snapshots it first) or an existing snapshot. */
  type: "volume" | "snapshot";
  /** Id of the volume or snapshot. */
  id: string;
}

export interface BackupProps extends ProjectScopedProps {
  /** Volume or snapshot to back up. Changing it replaces the backup. */
  source: BackupSource;
  /**
   * Name of the backup. Updated in place.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /** Free-text description. Updated in place; unmanaged when omitted. */
  description?: string;
  /**
   * Project of the backup. Defaults to the profile's project. Changing it
   * replaces the backup.
   */
  projectId?: string;
  /**
   * Region of the backup. Defaults to the profile's region. Changing it
   * replaces the backup.
   */
  region?: string;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface BackupAttributes {
  /** Backup id (UUID); use it as a volume `source` of type `backup`. */
  backupId: string;
  /** Name of the backup. */
  name: string;
  /** Description. */
  description: string | undefined;
  /** Volume the backup was taken of. */
  volumeId: string | undefined;
  /** Snapshot the backup was made from, if any. */
  snapshotId: string | undefined;
  /** Size in GB. */
  size: number | undefined;
  /** Availability zone of the source volume. */
  availabilityZone: string | undefined;
  /** Whether the backup is encrypted. */
  encrypted: boolean;
  /** Status, e.g. `AVAILABLE`. */
  status: string | undefined;
  /** Project of the backup. */
  projectId: string;
  /** Region of the backup. */
  region: string;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type Backup = Resource<
  "Stackit.IaaS.Backup",
  BackupProps,
  BackupAttributes,
  never,
  Providers
>;

/**
 * A STACKIT volume backup: a copy of a volume or snapshot kept in separate
 * backup storage, so it survives the deletion of its source. Restore it
 * into a new volume with `source: { type: "backup", id }`.
 *
 * The content is fixed at creation; name, description and labels update in
 * place. Creating a backup copies the whole volume and can take several
 * minutes for large volumes. Backups are billed per GB-hour.
 *
 * See [STACKIT's Block Storage docs](https://docs.stackit.cloud/products/storage/block-storage/).
 *
 * :::caution[Changing `source`, `projectId` or `region` replaces the Backup]
 * A deploy takes a new backup and deletes the old one. Content is never refreshed in
 * place: to take a fresh backup, change the logical id.
 * :::
 *
 * ### Backing up a volume
 * **Example:** Back up a data volume
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const data = yield* Stackit.IaaS.Volume("Data", { size: 20 });
 * const backup = yield* Stackit.IaaS.Backup("Weekly", {
 *   source: { type: "volume", id: data.volumeId },
 * });
 * ```
 *
 * **Example:** Back up an existing snapshot
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const data = yield* Stackit.IaaS.Volume("Data", { size: 20 });
 * const snapshot = yield* Stackit.IaaS.Snapshot("Nightly", {
 *   volumeId: data.volumeId,
 * });
 * const backup = yield* Stackit.IaaS.Backup("Offsite", {
 *   source: { type: "snapshot", id: snapshot.snapshotId },
 * });
 * ```
 *
 * @resource
 * @product STACKIT Block Storage
 * @category IaaS
 */
export const Backup = Resource<Backup>("Stackit.IaaS.Backup");

const READY_TIMEOUT = "20 minutes";

const isReady = (backup: iaas.Backup) => backup.status === "AVAILABLE";

const hasFailed = (backup: iaas.Backup) => (backup.status === "ERROR" ? backup.status : undefined);

const toAttrs = (backup: iaas.Backup, scope: ProjectScope, name: string): BackupAttributes => ({
  backupId: backup.id ?? "",
  name: backup.name ?? name,
  description: backup.description,
  volumeId: backup.volumeId,
  snapshotId: backup.snapshotId,
  size: backup.size,
  availabilityZone: backup.availabilityZone,
  encrypted: backup.encrypted ?? false,
  status: backup.status,
  ...scope,
  labels: stripInternalLabels(backup.labels),
});

const getBackup = (scope: ProjectScope, backupId: string) =>
  iaas.getBackup({ ...scope, backupId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** A listed backup was taken of the desired source. */
const fromSource = (source: BackupSource | undefined) => (backup: iaas.Backup) =>
  source === undefined ||
  (source.type === "volume" ? backup.volumeId === source.id : backup.snapshotId === source.id);

const observe = Effect.fn(function* (args: {
  id: string;
  name: string;
  scope: ProjectScope;
  backupId: string | undefined;
  source: BackupSource | undefined;
  instanceId: string | undefined;
}) {
  if (args.backupId !== undefined) {
    const byId = yield* getBackup(args.scope, args.backupId);
    if (byId !== undefined) return byId;
  }
  // Crash recovery: a create whose state was never persisted.
  const { items } = yield* iaas.listBackups(args.scope);
  return yield* findOwnedByName(args.id, args.name, items, {
    instanceId: args.instanceId,
    compatible: fromSource(args.source),
  });
});

const sourceKey = (source: BackupSource) => `${source.type}:${source.id}`;

export const BackupProvider = () =>
  Provider.succeed(Backup, {
    stables: ["backupId", "volumeId", "snapshotId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.Snapshot", "Stackit.IaaS.Volume"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listBackups(scope);
      return ownedOnly(items).map((backup) => toAttrs(backup, scope, backup.name ?? ""));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (hasUnresolvedTrigger<BackupProps>(news, ["projectId", "region", "source"])) {
        return { action: "replace" } as const;
      }
      const resolved = triggerProps<BackupProps>(news);
      if (yield* projectScopeChanged(resolved, output)) return { action: "replace" } as const;
      if (olds !== undefined && sourceKey(resolved.source) !== sourceKey(olds.source)) {
        return { action: "replace" } as const;
      }
      if (
        !fromSource(resolved.source)({ volumeId: output.volumeId, snapshotId: output.snapshotId })
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe({
        id,
        name,
        scope,
        backupId: output?.backupId,
        source: olds?.source,
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

      // Observe — a recorded backup only counts for the same source.
      const recordedId =
        output !== undefined &&
        fromSource(news.source)({ volumeId: output.volumeId, snapshotId: output.snapshotId })
          ? output.backupId
          : undefined;
      let current = yield* observe({
        id,
        name,
        scope,
        backupId: recordedId,
        source: news.source,
        instanceId,
      });

      // Ensure — create when missing.
      if (current === undefined) {
        current = yield* iaas.createBackup({
          ...scope,
          source: news.source,
          name,
          description: news.description,
          labels,
        });
      }
      const backupId = current.id;
      if (backupId === undefined) {
        return yield* new BackupIdMissing({
          resourceName: name,
          message: `STACKIT returned backup ${name} without an id`,
        });
      }
      let observed = isReady(current)
        ? current
        : yield* waitFor({
            resource: `STACKIT backup ${name}`,
            read: iaas.getBackup({ ...scope, backupId }),
            ready: isReady,
            failed: hasFailed,
            state: (backup) => backup.status,
            timeout: READY_TIMEOUT,
            maxInterval: "15 seconds",
          });

      // Sync — name, description and labels.
      const patch: Omit<iaas.UpdateBackupRequest, "projectId" | "region" | "backupId"> = {};
      if (observed.name !== name) patch.name = name;
      if (news.description !== undefined && observed.description !== news.description) {
        patch.description = news.description;
      }
      const labelPatch = labelsPatch(observed.labels, labels);
      if (labelPatch !== undefined) patch.labels = labelPatch;
      if (Object.keys(patch).length > 0) {
        observed = yield* iaas.updateBackup({ ...scope, backupId, ...patch });
      }
      return toAttrs({ ...observed, id: backupId }, scope, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .deleteBackup({ ...scope, backupId: output.backupId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT backup ${output.name}`,
        read: getBackup(scope, output.backupId),
        state: (backup) => backup.status,
        timeout: "10 minutes",
        maxInterval: "15 seconds",
      });
    }),
  });
