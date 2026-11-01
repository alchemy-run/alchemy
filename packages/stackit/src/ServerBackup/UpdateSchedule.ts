import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Schedule } from "./Schedule.ts";

export interface UpdateScheduleRequest extends Omit<
  serverBackup.UpdateBackupScheduleRequest,
  "projectId" | "region" | "serverId" | "backupScheduleId"
> {}

/**
 * Runtime binding for Server Backup `updateBackupSchedule`: replace a backup
 * schedule's settings, such as to pause it during maintenance. The API replaces the
 * whole schedule, so send every field. A deploy that changes the schedule's props
 * writes them back; one that doesn't leaves your change alone.
 *
 * Bind this operation to a {@link Schedule} in a Function/Worker init phase and
 * provide {@link UpdateScheduleHttp}. The schedule's project, region, server and id
 * are injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup-schedule.update` on the
 * project holding the schedule, so it reaches every server's schedules in that
 * project: STACKIT binds roles on projects, folders and organizations, not on a single
 * server. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Pausing a Schedule
 * **Example:** Pause the schedule during maintenance
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Nightly = Stackit.ServerBackup.Schedule("Nightly", {
 *   serverId: "00000000-0000-0000-0000-000000000000",
 *   rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=DAILY;INTERVAL=1",
 *   backupProperties: { name: "nightly", retentionPeriod: 14 },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const updateSchedule = yield* Stackit.ServerBackup.UpdateSchedule(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* updateSchedule({
 *           name: "nightly",
 *           rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=DAILY;INTERVAL=1",
 *           backupProperties: { name: "nightly", retentionPeriod: 14 },
 *           enabled: false,
 *         });
 *         return HttpServerResponse.text("paused");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.UpdateScheduleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface UpdateSchedule extends Binding.Service<
  UpdateSchedule,
  "Stackit.ServerBackup.UpdateSchedule",
  (
    schedule: Schedule,
  ) => Effect.Effect<
    (
      request: UpdateScheduleRequest,
    ) => Effect.Effect<
      serverBackup.BackupSchedule,
      serverBackup.UpdateBackupScheduleError,
      RuntimeContext
    >
  >
> {}

export const UpdateSchedule = Binding.Service<UpdateSchedule>(
  "Stackit.ServerBackup.UpdateSchedule",
);
