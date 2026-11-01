import type * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Schedule } from "./Schedule.ts";

export interface GetScheduleRequest extends Omit<
  serverUpdate.GetUpdateScheduleRequest,
  "projectId" | "region" | "serverId" | "scheduleId"
> {}

/**
 * Runtime binding for Server Update `getUpdateSchedule`: read an update schedule.
 *
 * Bind this operation to a {@link Schedule} in a Function/Worker init phase and
 * provide {@link GetScheduleHttp}. The schedule's project, region, server and id are
 * injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `server-update.update-schedule.get` on the
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
 *     const getSchedule = yield* Stackit.ServerUpdate.GetSchedule(yield* Weekly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const schedule = yield* getSchedule();
 *         return yield* HttpServerResponse.json({ enabled: schedule.enabled });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerUpdate.GetScheduleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Update Management
 * @category ServerUpdate
 */
export interface GetSchedule extends Binding.Service<
  GetSchedule,
  "Stackit.ServerUpdate.GetSchedule",
  (
    schedule: Schedule,
  ) => Effect.Effect<
    (
      request?: GetScheduleRequest,
    ) => Effect.Effect<
      serverUpdate.GetUpdateScheduleResponse,
      serverUpdate.GetUpdateScheduleError,
      RuntimeContext
    >
  >
> {}

export const GetSchedule = Binding.Service<GetSchedule>("Stackit.ServerUpdate.GetSchedule");
