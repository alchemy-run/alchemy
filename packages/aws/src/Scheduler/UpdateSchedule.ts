import type * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type {
  ScheduleTarget,
  ScheduleTargetRequest,
  ScheduleWriteClient,
  ScheduleWriteOptions,
} from "./ScheduleWriteTypes.ts";

export interface UpdateScheduleRequest extends Omit<
  scheduler.UpdateScheduleInput,
  "GroupName" | "Target" | "FlexibleTimeWindow"
> {
  /**
   * Target the schedule delivers to. `Arn` and `RoleArn` default to the
   * bound target and its execution role.
   * @default the bound target
   */
  Target?: ScheduleTargetRequest;
  /**
   * Flexible time window configuration.
   * @default { Mode: "OFF" }
   */
  FlexibleTimeWindow?: scheduler.FlexibleTimeWindow;
}

/**
 * The runtime client `UpdateSchedule(target)` returns.
 */
export type UpdateScheduleClient = ScheduleWriteClient<
  UpdateScheduleRequest,
  scheduler.UpdateScheduleOutput,
  scheduler.UpdateScheduleError
>;

/**
 * Runtime binding for `scheduler:UpdateSchedule`.
 *
 * Pairs with {@link CreateSchedule}: a deployed runtime reschedules or pauses
 * schedules it created (push a reminder back, disable a recurring job).
 * `UpdateSchedule` is a full PUT — unspecified fields are reset to their
 * defaults — so `at`, `every` and `cron` send the complete configuration.
 *
 * Like {@link CreateSchedule}, bind it to the Queue or Function the schedules
 * deliver to. It declares the same execution role and grants the host
 * `scheduler:UpdateSchedule` on the group's schedules plus `iam:PassRole` on
 * that role.
 * ### Updating Schedules At Runtime
 * **Example:** Push A Reminder Back A Day
 * ```typescript
 * const reschedule = yield* AWS.Scheduler.UpdateSchedule(queue);
 *
 * // runtime
 * yield* reschedule.at(new Date(Date.now() + 24 * 60 * 60_000), {
 *   name: `reminder-${userId}`,
 *   payload: { userId },
 * });
 * ```
 *
 * **Example:** Pause A Recurring Schedule
 * ```typescript
 * yield* reschedule.every("1 day", {
 *   name: `digest-${userId}`,
 *   state: "DISABLED",
 *   payload: { userId },
 * });
 * ```
 *
 * **Example:** Update Schedules In A Schedule Group
 * ```typescript
 * const reschedule = yield* AWS.Scheduler.UpdateSchedule(queue, { group });
 * ```
 *
 * @binding
 */
export interface UpdateSchedule extends Binding.Service<
  UpdateSchedule,
  "AWS.Scheduler.UpdateSchedule",
  <T extends ScheduleTarget>(
    target: T,
    options?: ScheduleWriteOptions,
  ) => Effect.Effect<UpdateScheduleClient>
> {}
export const UpdateSchedule = Binding.Service<UpdateSchedule>("AWS.Scheduler.UpdateSchedule");
