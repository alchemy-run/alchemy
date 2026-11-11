import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
    }
  | {
      /** Minimum delay before delivery. Zero schedules the callback as soon as possible. */
      readonly after: Duration.Input;
      readonly at?: never;
    }
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
