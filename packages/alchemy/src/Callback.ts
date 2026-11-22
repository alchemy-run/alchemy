import * as Context from "effect/Context";
import * as Cron from "effect/Cron";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { RuntimeContext } from "./RuntimeContext.ts";

/** A durable callback could not be registered, scheduled, cancelled, or dispatched. */
export class CallbackError extends Data.TaggedError("CallbackError")<{
  readonly callback: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type CallbackScheduleOptions<Payload> = {
  /** JSON-serializable data delivered to the callback. */
  readonly payload: Payload;
  /**
   * Committed source version or sequence, as a nonnegative safe integer. A
   * schedule whose progress is behind the pending job's can't replace it, so
   * a replayed external schedule never overwrites newer work.
   */
  readonly progress?: number;
} & (
  | {
      /** Absolute delivery time, as a Date or positive milliseconds since the Unix epoch. */
      readonly at: Date | number;
      readonly after?: never;
      readonly every?: never;
      readonly cron?: never;
      readonly timeZone?: never;
    }
  | {
      /** Minimum delay before delivery. Zero schedules the callback as soon as possible. */
      readonly after: Duration.Input;
      readonly at?: never;
      readonly every?: never;
      readonly cron?: never;
      readonly timeZone?: never;
    }
  | {
      /**
       * Deliver once per interval, first one interval from now. The job stays
       * pending after each delivery; a run missed during an outage is
       * delivered once, then the interval continues from its original start.
       */
      readonly every: Duration.Input;
      readonly at?: never;
      readonly after?: never;
      readonly cron?: never;
      readonly timeZone?: never;
    }
  | {
      /**
       * Deliver on a cron expression, with an optional leading seconds field:
       * `"0 9 * * *"`, `"*\/30 * * * * *"`. The job stays pending after each
       * delivery; runs missed during an outage are delivered once.
       */
      readonly cron: string;
      /** The IANA time zone the expression is read in. @default "UTC" */
      readonly timeZone?: string;
      readonly at?: never;
      readonly after?: never;
      readonly every?: never;
    }
);

/**
 * How a recurring job repeats, as an implementation stores it with the job:
 * an interval in milliseconds, or a cron expression.
 *
 * @internal For `Callbacks` implementations.
 */
export type CallbackRecurrence =
  | { readonly every: number }
  | { readonly cron: string; readonly timeZone?: string };

/**
 * When a job first runs, and how it repeats if it does. Fails on a schedule
 * that names no time or more than one, a negative delay, a non-positive
 * interval, or a cron expression or time zone that doesn't parse.
 *
 * @internal For `Callbacks` implementations.
 */
export const resolveCallbackSchedule = (
  callback: string,
  options: CallbackScheduleOptions<unknown>,
  now: number,
): Effect.Effect<
  { readonly at: number; readonly recurrence: CallbackRecurrence | undefined },
  CallbackError
> =>
  Effect.gen(function* () {
    const invalid = (message: string, cause?: unknown) =>
      new CallbackError({ callback, message, cause });
    const given = [options.at, options.after, options.every, options.cron].filter(
      (value) => value !== undefined,
    ).length;
    if (given !== 1) return yield* invalid("Specify exactly one of at, after, every or cron");
    if (options.at !== undefined) {
      const at = typeof options.at === "number" ? options.at : options.at.getTime();
      if (!Number.isFinite(at) || at <= 0) return yield* invalid("Delivery time must be positive");
      return { at, recurrence: undefined };
    }
    if (options.after !== undefined) {
      const delay = durationMillis(options.after);
      if (delay === undefined || delay < 0 || !Number.isFinite(delay)) {
        return yield* invalid("Delay must be non-negative and finite");
      }
      return { at: now + delay, recurrence: undefined };
    }
    if (options.every !== undefined) {
      const every = durationMillis(options.every);
      if (every === undefined || every <= 0 || !Number.isFinite(every)) {
        return yield* invalid("Interval must be positive and finite");
      }
      return { at: now + every, recurrence: { every } };
    }
    const recurrence: CallbackRecurrence =
      options.timeZone === undefined
        ? { cron: options.cron! }
        : { cron: options.cron!, timeZone: options.timeZone };
    const cron = yield* parseCron(callback, "Invalid cron schedule", recurrence);
    return { at: Cron.next(cron, now).getTime(), recurrence };
  });

/**
 * The run after one delivered at `scheduledAt`: the first occurrence after
 * `now`, so runs missed during an outage collapse into one.
 *
 * @internal For `Callbacks` implementations.
 */
export const nextCallbackRun = (
  callback: string,
  recurrence: CallbackRecurrence,
  scheduledAt: number,
  now: number,
): Effect.Effect<number, CallbackError> => {
  if ("every" in recurrence) {
    const { every } = recurrence;
    return Effect.succeed(
      scheduledAt > now
        ? scheduledAt + every
        : scheduledAt + every * (Math.floor((now - scheduledAt) / every) + 1),
    );
  }
  return parseCron(callback, "Invalid stored cron schedule", recurrence).pipe(
    Effect.map((cron) => Cron.next(cron, now).getTime()),
  );
};

const durationMillis = (input: Duration.Input) => {
  const millis = Option.getOrUndefined(Duration.fromInput(input));
  return millis === undefined ? undefined : Duration.toMillis(millis);
};

// `Cron.parse` returns a failure for a bad expression and throws for an
// unknown time zone.
const parseCron = (
  callback: string,
  message: string,
  recurrence: { readonly cron: string; readonly timeZone?: string },
): Effect.Effect<Cron.Cron, CallbackError> =>
  Effect.try({
    try: () => Cron.parse(recurrence.cron, recurrence.timeZone ?? "UTC"),
    catch: (cause) => new CallbackError({ callback, message, cause }),
  }).pipe(
    Effect.flatMap((result) =>
      Effect.fromResult(result).pipe(
        Effect.mapError((cause) => new CallbackError({ callback, message, cause })),
      ),
    ),
  );

/** Durable scheduling state, available without decoding the job's payload. */
export interface CallbackStatus {
  /** Requested delivery time in milliseconds since the Unix epoch. */
  readonly scheduledAt: number;
  /** Latest committed source cursor supplied when scheduling, if any. */
  readonly progress: number | undefined;
}

export interface Callback<Payload> {
  /** Schedule or replace a pending job identified by this callback's name and the supplied ID. */
  readonly schedule: (
    id: string,
    options: CallbackScheduleOptions<Payload>,
  ) => Effect.Effect<void, CallbackError, RuntimeContext>;
  /** Cancel a pending job. Cancelling an absent ID succeeds; an already-running handler is not interrupted. */
  readonly cancel: (id: string) => Effect.Effect<void, CallbackError, RuntimeContext>;
  /** Inspect a pending job. Returns undefined after successful completion or cancellation. */
  readonly getStatus: (
    id: string,
  ) => Effect.Effect<CallbackStatus | undefined, CallbackError, RuntimeContext>;
}

/**
 * Registers a durable callback and returns its scheduling client. A handler
 * can't fail: typed errors are its own to retry or handle. Each invocation
 * supplies a fresh Scope.
 */
export type CallbackFactory = <Payload, R>(
  name: string,
  handler: (payload: Payload) => Effect.Effect<unknown, never, R>,
) => Effect.Effect<Callback<Payload>, never, Exclude<R, Scope.Scope>>;

/**
 * The durable callback implementation a runtime is provided with. Each
 * backend is its own Layer: `AWS.Scheduler.SchedulerCallbacks` keeps jobs
 * as EventBridge Scheduler schedules that invoke a Lambda Function, and
 * `Cloudflare.DurableObjectCallbacks` keeps them in a Durable Object's
 * storage and fires them from its alarm.
 */
export class Callbacks extends Context.Service<
  Callbacks,
  {
    /** Register a callback with this implementation. */
    readonly make: CallbackFactory;
  }
>()("alchemy/Callbacks") {}

/**
 * Register a durable callback with the provided {@link Callbacks}
 * implementation.
 *
 * A callback is a named handler that runs later, at least once, for each job
 * scheduled with `schedule(id, { at | after, payload })`. Register every
 * callback while the runtime initializes; it routes each due job to the
 * handler registered under the job's callback name. Scheduling the same ID
 * again replaces the pending job, and `cancel(id)` removes it.
 *
 * The handler's error type is `never`. Retry or handle typed failures inside
 * it with `Effect.retry`, `Effect.catchTag` or a new schedule. Defects and
 * crashes (a timeout, an evicted instance, a deploy) are redelivered by the
 * implementation, so external writes must be idempotent.
 *
 * ### Registering and Scheduling a Callback
 * **Example:** Expire an order an hour after it is placed
 * ```typescript
 * const onExpire = yield* Alchemy.makeCallback(
 *   "expire",
 *   Effect.fn(function* ({ orderId }: { orderId: string }) {
 *     yield* expireOrder(orderId).pipe(
 *       Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }),
 *       Effect.orDie,
 *     );
 *   }),
 * );
 *
 * // runtime
 * yield* onExpire.schedule(orderId, { after: "1 hour", payload: { orderId } });
 * ```
 *
 * ### Cancelling or Replacing a Job
 * **Example:** Use a stable ID within a callback
 * ```typescript
 * yield* onExpire.schedule("order-42", {
 *   at: new Date("2026-10-01T09:00:00Z"),
 *   payload: { orderId: "order-42" },
 * });
 * yield* onExpire.cancel("order-42");
 * ```
 *
 * ### Recurring Jobs
 * A job scheduled with `every` or `cron` stays pending after each run, until
 * it is cancelled or scheduled again under the same ID. A run that fails is
 * redelivered like any other job, and the next run is the first one due after
 * it succeeds, so runs missed during an outage are delivered once.
 *
 * **Example:** Sweep every ten seconds and report every morning
 * ```typescript
 * const sweep = yield* Alchemy.makeCallback(
 *   "sweep",
 *   Effect.fn(function* () {
 *     yield* sweepExpired;
 *   }),
 * );
 * const report = yield* Alchemy.makeCallback(
 *   "report",
 *   Effect.fn(function* () {
 *     yield* sendReport;
 *   }),
 * );
 *
 * // runtime
 * yield* sweep.schedule("expired", { every: "10 seconds", payload: undefined });
 * yield* report.schedule("daily", {
 *   cron: "0 9 * * *",
 *   timeZone: "Europe/London",
 *   payload: undefined,
 * });
 * ```
 *
 * ### Choosing an Implementation
 * **Example:** A Lambda Function on EventBridge Scheduler
 * ```typescript
 * export default Orders.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const onExpire = yield* Alchemy.makeCallback("expire", expire);
 *     return { fetch: placeOrder(onExpire) };
 *   }).pipe(Effect.provide(AWS.Scheduler.SchedulerCallbacks())),
 * );
 * ```
 *
 * **Example:** A Durable Object on its own alarm
 * ```typescript
 * export default class Order extends Cloudflare.DurableObject<Order>()(
 *   "Order",
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const onArchive = yield* Alchemy.makeCallback("archive", archive);
 *       return { save: save(onArchive) };
 *     }).pipe(Effect.provide(Cloudflare.DurableObjectCallbacks));
 *   }),
 * ) {}
 * ```
 *
 * Callback names identify persisted jobs: keep a handler registered while
 * its jobs are pending. Payloads are JSON values that must stay compatible
 * with pending jobs from earlier deployments; their TypeScript types are not
 * decoded at runtime.
 */
export const makeCallback = <Payload, R>(
  name: string,
  handler: (payload: Payload) => Effect.Effect<unknown, never, R>,
): Effect.Effect<Callback<Payload>, never, Callbacks | Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    const callbacks = yield* Callbacks;
    return yield* callbacks.make(name, handler);
  });
