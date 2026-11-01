import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import {
  generatedServerObjectName,
  isOnTarget,
  listOwnedServers,
  recordedTarget,
  SERVER_OBJECT_NAME_MAX_LENGTH,
  type ServerTarget,
} from "../internal/servers.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  BACKUP_POLL,
  BACKUP_TIMEOUT,
  getBackupOrUndefined,
  isBackupFailed,
  listServerBackups,
} from "./internal.ts";

export interface BackupProps {
  /**
   * Server to back up. Pass it through a `Stackit.ServerBackup.Enablement` so the backup is
   * taken after it. Fixed: see {@link allowReplace}.
   */
  serverId: string;
  /**
   * Name of the backup, up to 255 characters. STACKIT can't rename a backup, so it is fixed: see
   * {@link allowReplace}.
   *
   * If omitted, a name is generated from the stack, stage and logical ID.
   */
  name?: string;
  /**
   * Days the backup is kept, from 1 to 36500. STACKIT can't change it on a backup, so it is
   * fixed: see {@link allowReplace}.
   */
  retentionPeriod: number;
  /**
   * Volumes to back up. All of the server's volumes if omitted. Fixed: see
   * {@link allowReplace}.
   */
  volumeIds?: string[];
  /**
   * STACKIT can't change a backup, and a backup holds the server as it was when taken. So a change
   * to `serverId`, `name`, `retentionPeriod`, `volumeIds`, `projectId` or `region` can only take a
   * new backup of the server as it is now and delete this one, which loses this point in time. Set
   * this to allow that. Without it, the plan fails with `Stackit.ServerBackup.BackupImmutable`
   * and nothing changes.
   *
   * @default false
   */
  allowReplace?: boolean;
  /**
   * Pass the API's `force` flag when deleting this backup. Without it, a delete waits for a
   * backup still being taken to finish, then asks STACKIT to delete it normally.
   *
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Project of the server. Defaults to the profile's project. Fixed: see {@link allowReplace}.
   */
  projectId?: string;
  /**
   * Region of the server. Defaults to the profile's region. Fixed: see {@link allowReplace}.
   */
  region?: string;
}

/** One volume's part of a backup. */
export interface BackupVolumeBackup {
  /** Id of the volume backup, for `RestoreVolumeBackup` and `DeleteVolumeBackup`. */
  volumeBackupId: string | undefined;
  /** Volume it was taken from. */
  volumeId: string | undefined;
  /** State of the volume backup. */
  status: string | undefined;
  /** Size STACKIT reports for it. */
  size: number | undefined;
  /** When it was last restored, if ever. */
  lastRestoredAt: string | undefined;
  /** Volume it was last restored to, if ever. */
  lastRestoredVolumeId: string | undefined;
}

export interface BackupAttributes {
  /** STACKIT backup id. A backup that expired is taken again under a new id. */
  backupId: string;
  /** Server the backup was taken from. */
  serverId: string;
  /** Project of the server. */
  projectId: string;
  /** Region of the server. */
  region: string;
  /** Name of the backup. */
  name: string;
  /** State of the backup; `available` after a deploy. */
  status: string;
  /** Size STACKIT reports for the backup. */
  size: number | undefined;
  /** When the backup was taken. */
  createdAt: string;
  /** When the retention period ends. */
  expireAt: string;
  /** When the backup was last restored, if ever. */
  lastRestoredAt: string | undefined;
  /** The volumes the backup holds. */
  volumeBackups: BackupVolumeBackup[];
}

export type Backup = Resource<
  "Stackit.ServerBackup.Backup",
  BackupProps,
  BackupAttributes,
  never,
  Providers
>;

/** A change that could only take a new backup and delete this one, with nothing opting in. */
export class BackupImmutable extends Data.TaggedError("Stackit.ServerBackup.BackupImmutable")<{
  readonly backupId: string;
  readonly changed: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * An on-demand backup of a server with STACKIT Server Backup Management, such as a snapshot
 * before a migration, kept for as long as it's in the stack and its retention lasts. The
 * server needs a `Stackit.ServerBackup.Enablement`. For one volume through the IaaS API, use
 * `Stackit.IaaS.Backup`. Backups aren't taken on a schedule here; that's
 * `Stackit.ServerBackup.Schedule`.
 *
 * Backups have no labels: Alchemy recognizes its own by the id in state or the generated
 * name, which holds the resource's instance id. A backup with the same explicit `name` found
 * without state is reported as unowned, and only taken over with `--adopt`; a backup a
 * schedule took under that name counts too, if it's the only one. `alchemy unsafe nuke`
 * enumerates only backups on Alchemy's servers whose name has the generated shape.
 *
 * Deploys wait until the backup is `available`, for up to 30 minutes. A backup that passed
 * `expireAt` and that STACKIT has removed is noticed by the next plan, and that deploy takes
 * a new one of the server as it is then.
 *
 * ### Taking a Backup
 * **Example:** Keep a snapshot for 30 days
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 * });
 * const preMigration = yield* Stackit.ServerBackup.Backup("PreMigration", {
 *   serverId: backups.serverId,
 *   retentionPeriod: 30,
 * });
 * ```
 *
 * ### Backing Up Some Volumes
 * **Example:** Only back up one volume
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const data = yield* Stackit.IaaS.Volume("DbData", { size: 100 });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 * });
 * yield* Stackit.ServerBackup.Backup("DataOnly", {
 *   serverId: backups.serverId,
 *   name: "data-only",
 *   retentionPeriod: 7,
 *   volumeIds: [data.volumeId],
 * });
 * ```
 *
 * ### Keeping a Backup After a Destroy
 * **Example:** Leave the backup behind when it leaves the stack
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 * });
 * yield* Stackit.ServerBackup.Backup("PreMigration", {
 *   serverId: backups.serverId,
 *   retentionPeriod: 365,
 * }).pipe(Alchemy.RemovalPolicy.retain());
 * ```
 *
 * **Example:** Take a new backup when the retention changes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 * });
 * yield* Stackit.ServerBackup.Backup("Latest", {
 *   serverId: backups.serverId,
 *   retentionPeriod: 60,
 *   allowReplace: true,
 * });
 * ```
 *
 * ### What Deleting Does <!-- api-prose -->
 * A delete deletes this one backup by its id and waits until it's gone, and its data is gone
 * with it. A backup still being taken is waited for first, unless `forceDestroy` is set or
 * `alchemy unsafe nuke` is running, which pass the API's `force` flag. No other backup or
 * schedule is touched.
 *
 * ### Replacement Cautions <!-- api-prose -->
 * A backup holds the server as it was when taken, and STACKIT can't change one. So a plan that
 * changes `name`, `retentionPeriod`, `volumeIds`, `serverId`, `projectId` or `region` fails with
 * `Stackit.ServerBackup.BackupImmutable`, naming what changed, and nothing happens. So does
 * replacing the server, or an enablement whose `serverId` you pass here. To keep this point in
 * time, add a second backup under a new logical ID and leave this one alone.
 *
 * With `allowReplace: true` the change goes ahead: it takes a new backup of the server **as it
 * is now**, waits until it's available, and then deletes the old one and its data. With
 * `RemovalPolicy.retain()` as well, the old one stays on the server and the stack stops tracking
 * it. The API reaches a backup only through its server, so a deleted server's backups can't be
 * reached any more; restore what you need before replacing it.
 *
 * @resource
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export const Backup = Resource<Backup>("Stackit.ServerBackup.Backup");

const toAttrs = (target: ServerTarget, backup: serverBackup.Backup): BackupAttributes => ({
  ...recordedTarget(target),
  backupId: backup.id,
  name: backup.name,
  status: backup.status,
  size: backup.size,
  createdAt: backup.createdAt,
  expireAt: backup.expireAt,
  lastRestoredAt: backup.lastRestoredAt,
  volumeBackups: (backup.volumeBackups ?? []).map((volume) => ({
    volumeBackupId: volume.id,
    volumeId: volume.volumeId,
    status: volume.status,
    size: volume.size,
    lastRestoredAt: volume.lastRestoredAt,
    lastRestoredVolumeId: volume.lastRestoredVolumeId,
  })),
});

const waitForAvailable = (target: ServerTarget, backupId: string, name: string) =>
  waitFor({
    resource: `STACKIT server backup ${name}`,
    // A backup just created can take a moment to be readable.
    read: getBackupOrUndefined(target, backupId),
    ready: (backup) => backup?.status === "available",
    failed: (backup) =>
      backup !== undefined && isBackupFailed(backup.status) ? backup.status : undefined,
    state: (backup) => backup?.status ?? "not visible yet",
    timeout: BACKUP_TIMEOUT,
    ...BACKUP_POLL,
  });

const waitForGone = (target: ServerTarget, backupId: string, name: string) =>
  waitUntilGone({
    resource: `STACKIT server backup ${name}`,
    read: getBackupOrUndefined(target, backupId),
    state: (backup) => backup.status,
    failed: (backup) => (backup.status === "error-deleting" ? backup.status : undefined),
    timeout: BACKUP_TIMEOUT,
    ...BACKUP_POLL,
  });

/** A failed create of this generation: nothing in it is worth keeping. */
const FAILED_CREATE: ReadonlySet<string> = new Set(["error", "error-creating", "inconsistent"]);

export const BackupProvider = () =>
  Provider.succeed(Backup, {
    // No `backupId`: a backup that expired is taken again under a new one.
    stables: ["serverId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.ServerBackup.Enablement"] },

    // No labels: only generated names on Alchemy's servers are enumerated.
    list: Effect.fn(function* () {
      const servers = yield* listOwnedServers;
      const owned: BackupAttributes[] = [];
      for (const target of servers) {
        for (const backup of yield* listServerBackups(target)) {
          if (isGeneratedPhysicalName(backup.name, SERVER_OBJECT_NAME_MAX_LENGTH)) {
            owned.push(toAttrs(target, backup));
          }
        }
      }
      return owned;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // A replacement loses the point in time this backup holds, so it takes an opt-in, and the
      // plan is where to refuse: nothing has happened yet. Never delete first: that would drop
      // the old backup before the new one exists. Nothing collides, because reconcile claims
      // only the id in state or this generation's name, and a schedule's backups all share one
      // name, so names aren't identities here.
      const replace = Effect.fn(function* (changed: ReadonlyArray<string>) {
        if (rawProp<BackupProps>(news, "allowReplace") !== true) {
          return yield* new BackupImmutable({
            backupId: output.backupId,
            changed,
            message: `Changing ${changed.join(", ")} would take a new backup of the server as it is now and delete backup ${output.name} (${output.backupId}), which holds it as it was. Nothing was changed. Add a second backup under a new logical ID to keep this one, or set allowReplace: true to replace it.`,
          });
        }
        return { action: "replace", deleteFirst: false } as const;
      });
      const triggers = [
        "serverId",
        "name",
        "retentionPeriod",
        "volumeIds",
        "projectId",
        "region",
      ] as const;
      const unresolved = triggers.filter((key) => hasUnresolvedTrigger<BackupProps>(news, [key]));
      if (unresolved.length > 0) return yield* replace(unresolved);
      const resolved = triggerProps<BackupProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const renamed =
        resolved.name !== undefined ? resolved.name !== output.name : olds?.name !== undefined;
      // Retention and volumes can't be read back as asked for, so only `olds` knows them.
      const changed = [
        ...(scopeChanged ? ["projectId or region"] : []),
        ...(renamed ? ["name"] : []),
        ...(resolved.serverId !== output.serverId ? ["serverId"] : []),
        ...(olds !== undefined && resolved.retentionPeriod !== olds.retentionPeriod
          ? ["retentionPeriod"]
          : []),
        ...(olds !== undefined && !sameMembers(resolved.volumeIds, olds.volumeIds)
          ? ["volumeIds"]
          : []),
      ];
      if (changed.length > 0) return yield* replace(changed);
      // The engine doesn't read a created row at plan, so an expired or deleted backup is only
      // noticed here. Reconcile then finds it missing and takes a new one.
      const live = yield* getBackupOrUndefined(recordedTarget(output), output.backupId);
      if (live === undefined) return { action: "update" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const serverId = output?.serverId ?? olds?.serverId;
      if (serverId === undefined) return undefined;
      const target = { ...scope, serverId };
      if (output !== undefined) {
        const byId = yield* getBackupOrUndefined(target, output.backupId);
        if (byId !== undefined) return toAttrs(target, byId);
      }
      const backups = yield* listServerBackups(target);
      if (olds?.name === undefined) {
        // A generated name holds this generation's instance id, so finding it proves it's ours.
        const generated = yield* generatedServerObjectName(id, instanceId);
        const found = backups.find((backup) => backup.name === generated);
        return found === undefined ? undefined : toAttrs(target, found);
      }
      // The generation being replaced isn't a match: its delete comes once this one is
      // available, and handing it to reconcile would make the replacement delete itself.
      const named = backups.filter(
        (backup) =>
          backup.name === olds.name &&
          !(isOnTarget(previous, target) && previous?.backupId === backup.id),
      );
      // A name found twice is evidently no identity, so it claims nothing.
      if (named.length !== 1) return undefined;
      return Unowned(toAttrs(target, named[0]!));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const target = { ...scope, serverId: news.serverId };
      const generated = yield* generatedServerObjectName(id, instanceId);
      const name = news.name ?? output?.name ?? generated;

      // Observe — `output` is a cache for the id, and only names the desired backup on the same
      // server. Without it, only this generation's generated name can be claimed.
      let current: serverBackup.Backup | undefined =
        output !== undefined && isOnTarget(output, target)
          ? yield* getBackupOrUndefined(target, output.backupId)
          : undefined;
      if (current === undefined && name === generated) {
        const backups = yield* listServerBackups(target);
        current = backups.find((backup) => backup.name === generated);
      }
      // A failed earlier attempt of this generation would fail every deploy from now on, and a
      // generated name proves it's ours. Anything else that failed is reported below.
      if (
        current !== undefined &&
        current.name === generated &&
        FAILED_CREATE.has(current.status)
      ) {
        const failedId = current.id;
        yield* serverBackup
          .deleteBackup({ ...target, backupId: failedId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitForGone(target, failedId, name);
        current = undefined;
      }

      // Ensure — a 409 means a backup of this server is running, which can be a schedule's.
      // Nothing is mutable after this: there's no update call.
      let backupId = current?.id;
      const createdNow = backupId === undefined;
      if (backupId === undefined) {
        const job = yield* serverBackup
          .createBackup({
            ...target,
            name,
            retentionPeriod: news.retentionPeriod,
            ...(news.volumeIds !== undefined ? { volumeIds: [...news.volumeIds] } : {}),
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              schedule: Schedule.spaced("30 seconds"),
              times: 20,
            }),
          );
        backupId = job.id;
      }
      const settledId = backupId;

      // A generated name lets the next deploy resume a backup that's just slow. A failed backup
      // we just created, or a slow one with an explicit name that state would lose, is deleted.
      const settle = waitForAvailable(target, settledId, name);
      const available = yield* createdNow
        ? settle.pipe(
            Effect.tapError((error) =>
              Effect.gen(function* () {
                if (error._tag === "Stackit.WaitTimeout" && name === generated) return;
                yield* serverBackup
                  .deleteBackup({ ...target, backupId: settledId, force: true })
                  .pipe(Effect.ignore);
              }),
            ),
          )
        : settle;
      return toAttrs(target, available!);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const target = recordedTarget(output);
      const current = yield* getBackupOrUndefined(target, output.backupId);
      if (current === undefined) return;
      // The API's `force` takes an opt-in: the prop, or `alchemy unsafe nuke`.
      const forced = olds?.forceDestroy === true || force === true;
      if (!forced && current.status === "in-progress") {
        yield* waitFor({
          resource: `STACKIT server backup ${output.name} to finish`,
          read: getBackupOrUndefined(target, output.backupId),
          ready: (backup) => backup?.status !== "in-progress",
          state: (backup) => backup?.status ?? "gone",
          timeout: BACKUP_TIMEOUT,
          ...BACKUP_POLL,
        });
      }
      yield* serverBackup
        .deleteBackup({
          ...target,
          backupId: output.backupId,
          ...(forced ? { force: true } : {}),
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitForGone(target, output.backupId, output.name);
    }),
  });
