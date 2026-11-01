import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Effect from "effect/Effect";
import type { ServerTarget } from "../internal/servers.ts";

/**
 * Shared scaffolding of the Server Backup resources. Not exported from the namespace barrel.
 *
 * Every read treats `NotFound` as missing: the spec documents it for a missing server, for a
 * missing object, and on the service read for "Server, or service, Not Found".
 */

/** Whether the service is on for the server. A missing server or service is off. */
export const isBackupServiceEnabled = (target: ServerTarget) =>
  serverBackup.getServiceResource(target).pipe(
    Effect.map(({ enabled }) => enabled === true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

export const listServerSchedules = (target: ServerTarget) =>
  serverBackup.listBackupSchedules(target).pipe(
    Effect.map(({ items }) => [...(items ?? [])]),
    Effect.catchTag("NotFound", () => Effect.succeed<serverBackup.BackupSchedule[]>([])),
  );

export const listServerBackups = (target: ServerTarget) =>
  serverBackup.listBackups(target).pipe(
    Effect.map(({ items }) => [...(items ?? [])]),
    Effect.catchTag("NotFound", () => Effect.succeed<serverBackup.Backup[]>([])),
  );

/**
 * What the service holds on a server, whoever made it. Nothing when the service is off, where
 * the API has nothing to list.
 */
export const listServerBackupObjects = (target: ServerTarget) =>
  Effect.gen(function* () {
    if (!(yield* isBackupServiceEnabled(target))) {
      return {
        schedules: [] as serverBackup.BackupSchedule[],
        backups: [] as serverBackup.Backup[],
      };
    }
    const schedules = yield* listServerSchedules(target);
    const backups = yield* listServerBackups(target);
    return { schedules, backups };
  });

export const getScheduleOrUndefined = (target: ServerTarget, scheduleId: string) =>
  serverBackup
    .getBackupSchedule({ ...target, backupScheduleId: scheduleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const getBackupOrUndefined = (target: ServerTarget, backupId: string) =>
  serverBackup
    .getBackup({ ...target, backupId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Time budget of a backup: it copies whole volumes, so size decides. */
export const BACKUP_TIMEOUT = "30 minutes";
export const BACKUP_POLL = { interval: "5 seconds", maxInterval: "30 seconds" } as const;

/** A backup in a state it will not leave for `available`. */
export const isBackupFailed = (status: string) =>
  status === "inconsistent" || status.startsWith("error");
