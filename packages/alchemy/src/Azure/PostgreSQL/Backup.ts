import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  getServer,
  POSTGRES_NAMESPACE,
  serverOwnedByStack,
  type ServerRef,
  whileServerBusy,
} from "./common.ts";

export interface BackupProps {
  /** Resource group of the server. Changing it replaces the backup. */
  resourceGroup: string;
  /** Name of the flexible server. Changing it replaces the backup. */
  server: string;
  /**
   * Backup name: letters, digits, `-`, and `_`. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it takes a
   * new backup.
   */
  name?: string;
}

export interface Backup extends Resource<
  "Azure.PostgreSQL.Backup",
  BackupProps,
  {
    /** Name of the backup. */
    backupName: string;
    /** ARM resource ID of the backup. */
    backupId: string;
    /** Name of the flexible server. */
    server: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Backup type (`Customer On-Demand`). */
    backupType: string | undefined;
    /** When the backup completed (UTC, ISO 8601). */
    completedTime: string | undefined;
    /** Source of the backup. */
    source: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An on-demand backup of an Azure Database for PostgreSQL flexible server.
 *
 * The backup is a point-in-time snapshot taken when the resource is
 * created; it is never refreshed. Deleting the resource deletes the
 * backup. On-demand backups need a General Purpose or Memory Optimized
 * server (Azure rejects them on Burstable) and are not supported on
 * `PremiumV2_LRS` storage.
 *
 * @see https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-backup-restore
 *
 * ### Taking a Backup
 * **Example:** Snapshot a server before a migration
 * ```typescript
 * const snapshot = yield* Azure.PostgreSQL.Backup("pre-migration", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 * });
 * ```
 *
 * @resource
 */
export const Backup = Resource<Backup>("Azure.PostgreSQL.Backup");

/**
 * Azure accepts the backup request on a Burstable server and then fails
 * the operation asynchronously (`CustomerOnDemandBackupCannotBePerformedOnBurstableServer`),
 * so the provider checks the tier up front.
 */
export class BackupNotSupportedOnBurstable extends Data.TaggedError(
  "Azure.PostgreSQL.BackupNotSupportedOnBurstable",
)<{ readonly server: string; readonly message: string }> {}

const createBackupName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return name.replace(/[^a-z0-9_-]/g, "-");
});

interface BackupRef extends ServerRef {
  readonly backupName: string;
}

const getBackup = (ref: BackupRef) =>
  orUndefinedIfNotFound(postgresql.GetBackupsAutomaticAndOnDemand(ref));

const toAttrs = (
  ref: BackupRef,
  backup: postgresql.GetBackupsAutomaticAndOnDemandResponse,
): Backup["Attributes"] => ({
  backupName: ref.backupName,
  backupId: backup.id ?? "",
  server: ref.serverName,
  resourceGroup: ref.resourceGroupName,
  backupType: backup.properties?.backupType,
  completedTime: backup.properties?.completedTime,
  source: backup.properties?.source,
});

const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

export const BackupProvider = () =>
  Provider.succeed(Backup, {
    stables: [
      "backupName",
      "backupId",
      "server",
      "resourceGroup",
      "backupType",
      "completedTime",
      "source",
    ],

    // Backups live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.server, output.server) ||
        (news.name !== undefined && news.name !== output.backupName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.server ?? olds?.server;
      if (resourceGroupName === undefined || serverName === undefined) {
        return undefined;
      }
      const ref: BackupRef = {
        subscriptionId,
        resourceGroupName,
        serverName,
        backupName:
          output?.backupName ?? olds?.name ?? (yield* createBackupName(id)),
      };
      const observed = yield* getBackup(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return (yield* serverOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, POSTGRES_NAMESPACE);
      const ref: BackupRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        serverName: news.server,
        backupName:
          news.name ?? output?.backupName ?? (yield* createBackupName(id)),
      };

      // Observe; a backup is an immutable snapshot (existence-only).
      const observed = yield* getBackup(ref);

      // Ensure. The PUT is a long-running operation that returns once
      // accepted; the backup appears when it has completed.
      if (observed === undefined) {
        const server = yield* getServer(ref);
        if (server?.sku?.tier === "Burstable") {
          return yield* new BackupNotSupportedOnBurstable({
            server: ref.serverName,
            message: `On-demand backups are not supported on Burstable server '${ref.serverName}'`,
          });
        }
        yield* postgresql
          .CreateBackupsAutomaticAndOnDemand(ref)
          .pipe(Effect.retry(whileServerBusy));
      }
      const fresh = yield* waitForProvisioned(
        `PostgreSQL backup ${ref.backupName}`,
        getBackup(ref),
        (backup) =>
          backup.properties?.completedTime ? undefined : "InProgress",
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: BackupRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.server,
        backupName: output.backupName,
      };
      yield* ignoreNotFound(
        postgresql
          .DeleteBackupsAutomaticAndOnDemand(ref)
          .pipe(Effect.retry(whileServerBusy)),
      );
      yield* waitUntilGone(
        `PostgreSQL backup ${output.backupName}`,
        getBackup(ref),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.PostgreSQL.FlexibleServer"] },
  });
