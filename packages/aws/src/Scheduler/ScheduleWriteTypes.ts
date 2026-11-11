import type * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as Effect from "effect/Effect";
import type { Role } from "../IAM/Role.ts";
import type { Key } from "../KMS/Key.ts";
import type { Function as LambdaFunction } from "../Lambda/Function.ts";
import type { Queue } from "../SQS/Queue.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

/**
 * What a runtime-minted schedule can deliver to: an SQS Queue (the schedule
 * sends a message) or a Lambda Function (the schedule invokes it).
 */
export type ScheduleTarget = Queue | LambdaFunction;

/**
 * Options for `CreateSchedule(target, options)` and
 * `UpdateSchedule(target, options)`.
 */
export interface ScheduleWriteOptions {
  /**
   * Schedule group the host may write schedules in. The binding is granted
   * on this group's schedules only.
   * @default the AWS default group
   */
  group?: ScheduleGroup;
  /**
   * Execution role EventBridge Scheduler assumes to deliver to the target.
   * When omitted, the binding declares a role that Scheduler may assume and
   * that may only send to (or invoke) the target, the dead-letter queue and
   * the KMS key below. A role you pass must allow those itself.
   * @default a role derived from the target
   */
  role?: Role;
  /**
   * Queue that deliveries Scheduler gives up on are sent to. Every schedule
   * the client writes uses it, and the generated role may send to it.
   * @default no dead-letter queue
   */
  deadLetterQueue?: Queue;
  /**
   * Customer managed KMS key that encrypts each schedule's target input.
   * Every schedule the client writes uses it, and the generated role may
   * decrypt with it.
   * @default an AWS owned key
   */
  kmsKey?: Key;
}

/**
 * The schedule target in a raw request. `Arn` and `RoleArn` default to the
 * bound target and its execution role, so callers normally send only `Input`.
 * A `DeadLetterConfig` set here instead of the binding's `deadLetterQueue`
 * is not granted to the generated role.
 */
export interface ScheduleTargetRequest extends Omit<scheduler.Target, "Arn" | "RoleArn"> {
  /**
   * ARN of the resource the schedule delivers to.
   * @default the bound target's ARN
   */
  Arn?: string;
  /**
   * Execution role EventBridge Scheduler assumes to deliver to the target.
   * @default the bound execution role
   */
  RoleArn?: string;
}

/**
 * Options for the `at`/`every`/`cron` shortcuts on a schedule client.
 */
export interface ScheduleRequestOptions {
  /** Name of the schedule, unique within its group. */
  name: string;
  /**
   * Payload delivered to the target: the message body for a Queue, the event
   * for a Function. Strings are sent as-is; anything else is JSON-encoded.
   */
  payload?: unknown;
  /** Description on the schedule. */
  description?: string;
  /** Date before which the schedule does not fire. */
  startDate?: Date;
  /** Date after which the schedule stops firing. */
  endDate?: Date;
  /** Desired schedule state (`ENABLED` / `DISABLED`). */
  state?: string;
  /**
   * Flexible time window configuration.
   * @default { Mode: "OFF" }
   */
  flexibleTimeWindow?: scheduler.FlexibleTimeWindow;
  /** Retry policy for failed deliveries. */
  retryPolicy?: scheduler.RetryPolicy;
  /** SQS-specific parameters (e.g. `MessageGroupId` for FIFO queues). */
  sqs?: scheduler.SqsParameters;
}

/**
 * Options for the `at` shortcut. `at` takes an absolute `Date`, so there is no
 * timezone option.
 */
export interface AtScheduleOptions extends ScheduleRequestOptions {
  /**
   * What happens once the one-time schedule fires.
   * @default "DELETE"
   */
  actionAfterCompletion?: string;
}

/**
 * Options for the `every` and `cron` shortcuts.
 */
export interface RecurringScheduleOptions extends ScheduleRequestOptions {
  /** Timezone the cron expression is evaluated in. */
  timezone?: string;
}

/**
 * A runtime client for a schedule write operation, bound to one target.
 * Call it with a raw request, or use `at`/`every`/`cron`, which mirror the
 * deploy-time `at(date).toQueue(queue, payload)` builders.
 */
export interface ScheduleWriteClient<Request, A, E> {
  (request: Request): Effect.Effect<A, E>;
  /** Fire once at `date`. The schedule deletes itself after it fires. */
  at(date: Date, options: AtScheduleOptions): Effect.Effect<A, E>;
  /** Fire on a rate, e.g. `"5 minutes"` or `"1 day"`. */
  every(rate: string, options: RecurringScheduleOptions): Effect.Effect<A, E>;
  /** Fire on a cron expression, e.g. `"cron(0 9 * * ? *)"`. */
  cron(expression: string, options: RecurringScheduleOptions): Effect.Effect<A, E>;
}
