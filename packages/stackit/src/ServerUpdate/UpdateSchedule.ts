import type * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Schedule } from "./Schedule.ts";

export interface UpdateScheduleRequest extends Omit<
  serverUpdate.UpdateUpdateScheduleRequest,
  "projectId" | "region" | "serverId" | "scheduleId"
> {}

/**
 * Runtime binding for Server Update `updateUpdateSchedule`: replace an update
 * schedule's settings, such as to pause it during a release. The API replaces the
 * whole schedule, so send every field. A deploy that changes the schedule's props
 * writes them back; one that doesn't leaves your change alone.
 *
 * Bind this operation to a {@link Schedule} in a Function/Worker init phase and
 * provide {@link UpdateScheduleHttp}. The schedule's project, region, server and id
 * are injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `server-update.update-schedule.update` on the
 * project holding the schedule, so it reaches every server's schedules in that
 * project: STACKIT binds roles on projects, folders and organizations, not on a single
 * server. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Pausing a Schedule
 * **Example:** Pause the schedule during a release
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Weekly = Stackit.ServerUpdate.Schedule("Weekly", {
 *   serverId: "00000000-0000-0000-0000-000000000000",
 *   rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=WEEKLY;INTERVAL=1",
 *   maintenanceWindow: 2,
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const updateSchedule = yield* Stackit.ServerUpdate.UpdateSchedule(yield* Weekly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* updateSchedule({
 *           name: "weekly",
 *           rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=WEEKLY;INTERVAL=1",
 *           maintenanceWindow: 2,
 *           enabled: false,
 *         });
 *         return HttpServerResponse.text("paused");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerUpdate.UpdateScheduleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Update Management
 * @category ServerUpdate
 */
export interface UpdateSchedule extends Binding.Service<
  UpdateSchedule,
  "Stackit.ServerUpdate.UpdateSchedule",
  (
    schedule: Schedule,
  ) => Effect.Effect<
    (
      request: UpdateScheduleRequest,
    ) => Effect.Effect<
      serverUpdate.UpdateUpdateScheduleResponse,
      serverUpdate.UpdateUpdateScheduleError,
      RuntimeContext
    >
  >
> {}

export const UpdateSchedule = Binding.Service<UpdateSchedule>(
  "Stackit.ServerUpdate.UpdateSchedule",
);
