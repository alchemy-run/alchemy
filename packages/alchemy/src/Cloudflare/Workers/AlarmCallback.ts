import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as Logger from "effect/Logger";
import { RuntimeContext } from "../../RuntimeContext.ts";
import {
  ensureAlarmTables,
  reconcileDurableObjectAlarm,
} from "./DurableObjectAlarmStorage.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import {
  fromDurableObjectStorage,
  type DurableObjectStorageError,
} from "./DurableObjectStorage.ts";

/** A scheduled alarm could not be registered, encoded, or dispatched. */
export class AlarmCallbackError extends Data.TaggedError("AlarmCallbackError")<{
  readonly callback: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AlarmCallbackOptions {
  /** Recovery delay after an unsuccessful or interrupted delivery. Defaults to 30 seconds. */
  readonly retry?: {
    /** Must be a finite, positive duration. */
    readonly delay: Duration.Input;
  };
}

export type AlarmScheduleOptions<Payload> = {
  /** JSON-serializable data delivered to the callback. */
  readonly payload: Payload;
} & (
  | {
      /** Absolute delivery time, as a Date or milliseconds since the Unix epoch. */
      readonly at: Date | number;
      readonly after?: never;
    }
  | {
      /** Delay before delivery. Zero schedules the callback as soon as possible. */
      readonly after: Duration.Input;
      readonly at?: never;
    }
);

export interface AlarmCallback<Payload> {
  /** Schedule or replace the job identified by this callback's name and the supplied ID. */
  readonly schedule: (
    id: string,
    options: AlarmScheduleOptions<Payload>,
  ) => Effect.Effect<
    void,
    AlarmCallbackError | DurableObjectStorageError,
    RuntimeContext
  >;
  /** Cancel a pending job. Cancelling an absent ID succeeds. */
  readonly cancel: (
    id: string,
  ) => Effect.Effect<void, DurableObjectStorageError, RuntimeContext>;
}

type InvocationServices = RuntimeContext | DurableObjectState | Scope.Scope;
interface RegisteredCallback {
  readonly retryDelay: number;
  readonly handler: (
    payload: unknown,
  ) => Effect.Effect<unknown, unknown, InvocationServices>;
}
interface CallbackRegistry {
  readonly callbacks: Map<string, RegisteredCallback>;
  open: boolean;
}
type AlarmRow = {
  callback: string;
  id: string;
  version: string;
  run_at: number;
  payload: string;
};
const registries = new WeakMap<cf.DurableObjectState, CallbackRegistry>();

/** @internal */
export const initializeAlarmCallbacks = (state: cf.DurableObjectState) => {
  const registry: CallbackRegistry = { callbacks: new Map(), open: true };
  registries.set(state, registry);
  return () => {
    registry.open = false;
  };
};

/**
 * Register a durable alarm callback in a Durable Object's per-instance Effect.
 * Alchemy dispatches scheduled jobs through the native alarm handler and removes
 * each job only after its callback succeeds. Delivery is at least once: handlers
 * performing external I/O must be idempotent.
 *
 * ### Registering and Scheduling a Callback
 * **Example:** Persist a document and schedule its archival atomically
 * ```typescript
 * const state = yield* Cloudflare.DurableObjectState;
 * return Effect.gen(function* () {
 *   const onArchive = yield* Cloudflare.makeAlarmCallback(
 *     "archive",
 *     Effect.fn(function* (payload: { key: string; body: string }) {
 *       yield* archive.put(payload.key, payload.body);
 *     }),
 *   );
 *   return {
 *     save: Effect.fn(function* (id: string, body: string) {
 *       yield* state.storage.transaction(
 *         Effect.gen(function* () {
 *           yield* state.storage.put(id, body);
 *           yield* onArchive.schedule(id, {
 *             after: "30 seconds",
 *             payload: { key: id, body },
 *           });
 *         }),
 *       );
 *     }),
 *   };
 * });
 * ```
 *
 * ### Cancelling or Replacing a Job
 * **Example:** Use a stable ID within a callback
 * ```typescript
 * yield* onArchive.schedule("revision-42", {
 *   at: new Date("2026-10-01T09:00:00Z"),
 *   payload: { key: "42.txt", body: "hello" },
 * });
 * yield* onArchive.cancel("revision-42");
 * ```
 *
 * ### Delivery and Schema Upgrades <!-- api-prose -->
 * Before invoking a callback, the dispatcher persists a recovery wake (30 seconds
 * by default). Failures remain pending, including across instance reconstruction.
 * A successful handler does not acknowledge a replacement it scheduled under the
 * same ID. Up to 100 due jobs are processed per native alarm invocation.
 *
 * Callback names identify persisted jobs; retain a handler for old names while
 * jobs are pending. Payloads must be JSON-serializable and compatible with pending
 * jobs from previous deployments; TypeScript types do not perform runtime decoding.
 *
 * The original unversioned scheduleEvent table is schema version 0. Its rows are
 * preserved by the atomic version 1 migration and continue through an explicitly
 * returned alarm handler using processScheduledEvents. Both schedulers share the
 * earliest native wake-up. Unknown newer schema versions fail without modification.
 * Direct setAlarm/deleteAlarm calls bypass this coordination.
 *
 * @binding
 */
export const makeAlarmCallback = <Payload, E, R>(
  name: string,
  handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
  options?: AlarmCallbackOptions,
): Effect.Effect<
  AlarmCallback<Payload>,
  never,
  DurableObjectState | RuntimeContext | Exclude<R, InvocationServices>
> =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const context = (yield* Effect.context<
      Exclude<R, InvocationServices>
    >()).pipe(
      Context.omit(
        DurableObjectState,
        RuntimeContext,
        Scope.Scope,
        Tracer.ParentSpan,
        Tracer.Tracer,
        Logger.CurrentLoggers,
      ),
    );
    const registry = registries.get(state.raw);
    if (!registry?.open || !name || registry.callbacks.has(name)) {
      return yield* Effect.die(
        new AlarmCallbackError({
          callback: name,
          message: !registry?.open
            ? "Alarm callbacks must be registered during Durable Object instance initialization"
            : "Alarm callback names must be non-empty and unique within an instance",
        }),
      );
    }
    const retryDelay = yield* Effect.sync(() =>
      Duration.toMillis(options?.retry?.delay ?? "30 seconds"),
    );
    if (!Number.isFinite(retryDelay) || retryDelay <= 0) {
      return yield* Effect.die(
        new AlarmCallbackError({
          callback: name,
          message: "Alarm retry delay must be finite and positive",
        }),
      );
    }
    yield* Effect.sync(() =>
      registry.callbacks.set(name, {
        retryDelay,
        handler: (payload) =>
          Effect.gen(function* () {
            const invocation = yield* Effect.context<InvocationServices>();
            return yield* handler(payload as Payload).pipe(
              Effect.provide(
                Context.merge(invocation, context) as Context.Context<R>,
              ),
            );
          }),
      }),
    );

    const raw = state.raw.storage;
    return {
      schedule: Effect.fn(function* (
        id: string,
        schedule: AlarmScheduleOptions<Payload>,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const { at, payload } = yield* Effect.try({
          try: () => {
            if (!id) throw new Error("Alarm IDs must be non-empty");
            if (
              (schedule.at === undefined) ===
              (schedule.after === undefined)
            ) {
              throw new Error("Specify exactly one of at or after");
            }
            const delay =
              schedule.after === undefined
                ? undefined
                : Duration.toMillis(schedule.after);
            const at =
              schedule.at === undefined
                ? now + delay!
                : schedule.at instanceof Date
                  ? schedule.at.getTime()
                  : schedule.at;
            if (
              !Number.isFinite(at) ||
              at <= 0 ||
              (delay !== undefined && (!Number.isFinite(delay) || delay < 0))
            ) {
              throw new Error(
                "Alarm time must be finite and delay must be non-negative",
              );
            }
            if (!Schema.is(Schema.Json)(schedule.payload)) {
              throw new Error("Alarm payload must be a JSON value");
            }
            const payload = JSON.stringify(schedule.payload);
            if (payload === undefined)
              throw new Error("Alarm payload must be JSON-serializable");
            return { at, payload };
          },
          catch: (cause) =>
            new AlarmCallbackError({
              callback: name,
              message: "Invalid alarm schedule",
              cause,
            }),
        });
        const version = yield* Effect.sync(() => crypto.randomUUID());
        yield* state.storage.transaction(
          Effect.gen(function* () {
            yield* ensureAlarmTables(raw);
            yield* Effect.sync(() =>
              raw.sql.exec(
                `INSERT INTO alchemy_alarm_callbacks (callback, id, version, run_at, payload)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (callback, id) DO UPDATE SET
             version = excluded.version, run_at = excluded.run_at, payload = excluded.payload`,
                name,
                id,
                version,
                at,
                payload,
              ),
            );
            yield* reconcileDurableObjectAlarm(raw);
          }),
        );
      }),
      cancel: Effect.fn(function* (id: string) {
        yield* state.storage.transaction(
          Effect.gen(function* () {
            yield* ensureAlarmTables(raw);
            yield* Effect.sync(() =>
              raw.sql.exec(
                "DELETE FROM alchemy_alarm_callbacks WHERE callback = ? AND id = ?",
                name,
                id,
              ),
            );
            yield* reconcileDurableObjectAlarm(raw);
          }),
        );
      }),
    };
  });

/** @internal */
export const dispatchAlarmCallbacks = (
  state: cf.DurableObjectState,
  hasLegacyHandler: boolean,
) =>
  Effect.gen(function* () {
    const registry = registries.get(state);
    if (!registry) return;
    const raw = state.storage;
    if (registry.callbacks.size === 0) {
      const hasJobs = yield* Effect.sync(
        () =>
          raw.sql
            ?.exec(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('alchemy_alarm_callbacks', 'alchemy_alarm_schema', 'alchemy_scheduled_events')",
            )
            .toArray().length > 0,
      );
      if (!hasJobs) return;
    }
    const storage = fromDurableObjectStorage(raw);
    yield* ensureAlarmTables(raw);
    if (!hasLegacyHandler) {
      const legacy = yield* Effect.sync(() =>
        raw.sql
          .exec("SELECT id FROM alchemy_scheduled_events LIMIT 1")
          .toArray(),
      );
      if (legacy.length > 0) {
        return yield* Effect.fail(
          new AlarmCallbackError({
            callback: "scheduleEvent",
            message:
              "Pending legacy events require an alarm handler calling processScheduledEvents",
          }),
        );
      }
    }
    const now = yield* Clock.currentTimeMillis;
    const due = yield* Effect.sync(() =>
      raw.sql
        .exec<AlarmRow>(
          `SELECT callback, id, version, run_at, payload FROM alchemy_alarm_callbacks
       WHERE run_at <= ? ORDER BY run_at, callback, id LIMIT 100`,
          now,
        )
        .toArray(),
    );
    for (const job of due) {
      const callback = registry.callbacks.get(job.callback);
      const claimed = yield* storage.transaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const claimed = yield* Effect.sync(
            () =>
              raw.sql.exec(
                `UPDATE alchemy_alarm_callbacks SET run_at = ?
           WHERE callback = ? AND id = ? AND version = ?`,
                now + (callback?.retryDelay ?? 30_000),
                job.callback,
                job.id,
                job.version,
              ).rowsWritten > 0,
          );
          yield* reconcileDurableObjectAlarm(raw);
          return claimed;
        }),
      );
      if (!claimed) continue;
      const result = yield* Effect.gen(function* () {
        if (!callback) {
          return yield* Effect.fail(
            new AlarmCallbackError({
              callback: job.callback,
              message: "No handler is registered for a pending alarm",
            }),
          );
        }
        const payload = yield* Effect.try({
          try: () => JSON.parse(job.payload),
          catch: (cause) =>
            new AlarmCallbackError({
              callback: job.callback,
              message: "Invalid persisted alarm payload",
              cause,
            }),
        });
        yield* callback.handler(payload);
      }).pipe(Effect.scoped, Effect.exit);
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause))
          return yield* Effect.failCause(result.cause);
        yield* Effect.logError(
          "Durable Object alarm callback failed",
          result.cause,
        );
        continue;
      }
      yield* storage.transaction(
        Effect.gen(function* () {
          yield* Effect.sync(() =>
            raw.sql.exec(
              "DELETE FROM alchemy_alarm_callbacks WHERE callback = ? AND id = ? AND version = ?",
              job.callback,
              job.id,
              job.version,
            ),
          );
          yield* reconcileDurableObjectAlarm(raw);
        }),
      );
    }
    yield* storage.transaction(reconcileDurableObjectAlarm(raw));
  });
