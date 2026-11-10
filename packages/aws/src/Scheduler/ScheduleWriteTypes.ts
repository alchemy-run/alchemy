import type * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as Effect from "effect/Effect";
import type { Role } from "../IAM/Role.ts";
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
   * that may only send to (or invoke) the target.
   * @default a role derived from the target
   */
  role?: Role;
}

/**
 * The schedule target in a raw request. `Arn` and `RoleArn` default to the
 * bound target and its execution role, so callers normally send only `Input`.
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
  /** KMS key ARN used to encrypt the schedule's target input. */
  kmsKeyArn?: string;
  /**
   * Flexible time window configuration.
   * @default { Mode: "OFF" }
   */
  flexibleTimeWindow?: scheduler.FlexibleTimeWindow;
  /** Retry policy for failed deliveries. */
  retryPolicy?: scheduler.RetryPolicy;
  /** Dead-letter queue for undeliverable deliveries. */
  deadLetterConfig?: scheduler.DeadLetterConfig;
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
