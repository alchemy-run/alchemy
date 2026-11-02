import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Schedule } from "./Schedule.ts";

export interface GetScheduleRequest extends Omit<
  serverBackup.GetBackupScheduleRequest,
  "projectId" | "region" | "serverId" | "backupScheduleId"
> {}

/**
 * Runtime binding for Server Backup `getBackupSchedule`: read a backup schedule.
 *
 * Bind this operation to a {@link Schedule} in a Function/Worker init phase and
 * provide {@link GetScheduleHttp}. The schedule's project, region, server and id are
 * injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.backup-schedule.get` on the
 * project holding the schedule, so it reaches every server's schedules in that
 * project: STACKIT binds roles on projects, folders and organizations, not on a single
 * server. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Schedule
 * **Example:** Report whether the schedule runs
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
 *     const getSchedule = yield* Stackit.ServerBackup.GetSchedule(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const schedule = yield* getSchedule();
 *         return yield* HttpServerResponse.json({ enabled: schedule.enabled });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.GetScheduleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface GetSchedule extends Binding.Service<
  GetSchedule,
  "Stackit.ServerBackup.GetSchedule",
  (
    schedule: Schedule,
  ) => Effect.Effect<
    (
      request?: GetScheduleRequest,
    ) => Effect.Effect<
      serverBackup.BackupSchedule,
      serverBackup.GetBackupScheduleError,
      RuntimeContext
    >
  >
> {}

export const GetSchedule = Binding.Service<GetSchedule>("Stackit.ServerBackup.GetSchedule");
