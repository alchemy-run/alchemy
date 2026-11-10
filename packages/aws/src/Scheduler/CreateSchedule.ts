import type * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type {
  ScheduleTarget,
  ScheduleTargetRequest,
  ScheduleWriteClient,
  ScheduleWriteOptions,
} from "./ScheduleWriteTypes.ts";

export interface CreateScheduleRequest extends Omit<
  scheduler.CreateScheduleInput,
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
 * The runtime client `CreateSchedule(target)` returns.
 */
export type CreateScheduleClient = ScheduleWriteClient<
  CreateScheduleRequest,
  scheduler.CreateScheduleOutput,
  scheduler.CreateScheduleError
>;

/**
 * Runtime binding for `scheduler:CreateSchedule`, for schedules a deployed
 * runtime creates while it runs: per-user reminders, delayed callbacks,
 * recurring jobs a user turns on.
 *
 * Bind it to the Queue or Function the schedules deliver to. At deploy time
 * the binding declares the execution role EventBridge Scheduler assumes
 * (allowed to send to that Queue or invoke that Function) and grants the
 * host `scheduler:CreateSchedule` on the group's schedules plus
 * `iam:PassRole` on that role.
 *
 * The client's `at`, `every` and `cron` match the deploy-time
 * `at(date).toQueue(queue, payload)` builders.
 * ### Creating Schedules At Runtime
 * **Example:** Send A Reminder To A Queue In 15 Minutes
 * ```typescript
 * const queue = yield* AWS.SQS.Queue("Reminders");
 * const schedule = yield* AWS.Scheduler.CreateSchedule(queue);
 *
 * // runtime
 * yield* schedule.at(new Date(Date.now() + 15 * 60_000), {
 *   name: `reminder-${userId}`,
 *   payload: { userId },
 * });
 * ```
 *
 * **Example:** Invoke A Function Every Day
 * ```typescript
 * const schedule = yield* AWS.Scheduler.CreateSchedule(digestFunction);
 *
 * // runtime
 * yield* schedule.every("1 day", {
 *   name: `digest-${userId}`,
 *   payload: { userId },
 * });
 * ```
 *
 * **Example:** Call This Function Back Later
 * ```typescript
 * // bind the host Function to itself for delayed callbacks
 * const self = yield* AWS.Lambda.Function;
 * const callback = yield* AWS.Scheduler.CreateSchedule(self);
 *
 * // runtime: the payload arrives as the invocation event
 * yield* callback.at(new Date(Date.now() + 60 * 60_000), {
 *   name: `expire-${orderId}`,
 *   payload: { orderId },
 * });
 * ```
 *
 * A callback to the host itself invokes the function's unqualified ARN,
 * even when the function routes through an alias.
 *
 * **Example:** Run On A Cron Expression In A Timezone
 * ```typescript
 * yield* schedule.cron("cron(0 9 * * ? *)", {
 *   name: `standup-${teamId}`,
 *   timezone: "America/New_York",
 *   payload: { teamId },
 * });
 * ```
 *
 * ### Scoping And Roles
 * **Example:** Create Schedules In A Schedule Group
 * ```typescript
 * const group = yield* AWS.Scheduler.ScheduleGroup("Reminders", {});
 * const schedule = yield* AWS.Scheduler.CreateSchedule(queue, { group });
 * ```
 *
 * **Example:** Use An Existing Execution Role
 * ```typescript
 * const schedule = yield* AWS.Scheduler.CreateSchedule(queue, { role });
 * ```
 *
 * **Example:** Send A Raw CreateSchedule Request
 * ```typescript
 * // Target.Arn and Target.RoleArn default to the bound target and role
 * yield* schedule({
 *   Name: `reminder-${userId}`,
 *   ScheduleExpression: "at(2026-01-01T00:00:00)",
 *   ActionAfterCompletion: "DELETE",
 *   Target: { Input: JSON.stringify({ userId }) },
 * });
 * ```
 *
 * @binding
 */
export interface CreateSchedule extends Binding.Service<
  CreateSchedule,
  "AWS.Scheduler.CreateSchedule",
  <T extends ScheduleTarget>(
    target: T,
    options?: ScheduleWriteOptions,
  ) => Effect.Effect<CreateScheduleClient>
> {}
export const CreateSchedule = Binding.Service<CreateSchedule>("AWS.Scheduler.CreateSchedule");
