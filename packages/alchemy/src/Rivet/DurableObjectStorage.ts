import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { ALARM_ACTION, NativeContext } from "./DurableObjectState.ts";

/** Lexicographic selection of keys in the actor's persisted state. */
export interface DurableObjectListOptions {
  /** Inclusive lower bound. */
  start?: string;
  /** Exclusive lower bound. */
  startAfter?: string;
  /** Exclusive upper bound. */
  end?: string;
  /** Required key prefix. */
  prefix?: string;
  /** Return keys in descending order. */
  reverse?: boolean;
  /** Maximum number of entries to return. */
  limit?: number;
}

/** Embedded SQLite queries return Rivet's materialized row objects. */
export interface SqlStorage {
  /** Execute a query using the native database client's binding conventions. */
  exec<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): Effect.Effect<Row[], never, RuntimeContext>;
}

/** Rivet actor-state storage; writes use the native persistence policy. */
export interface DurableObjectStorage {
  /** Read a value from persisted actor state. */
  get<T = unknown>(
    key: string,
  ): Effect.Effect<T | undefined, never, RuntimeContext>;
  /** Read the existing values for a set of keys. */
  get<T = unknown>(
    keys: string[],
  ): Effect.Effect<Map<string, T>, never, RuntimeContext>;
  /** Set a persisted actor-state value. */
  put<T>(key: string, value: T): Effect.Effect<void, never, RuntimeContext>;
  /** Set multiple persisted actor-state values. */
  put<T>(
    entries: Record<string, T>,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Remove a key and report whether it existed. */
  delete(key: string): Effect.Effect<boolean, never, RuntimeContext>;
  /** Remove keys and report the number removed. */
  delete(keys: string[]): Effect.Effect<number, never, RuntimeContext>;
  /** Clear the actor-state KV map, without affecting SQLite or alarms. */
  deleteAll(): Effect.Effect<void, never, RuntimeContext>;
  /** Select persisted entries in key order. */
  list<T = unknown>(
    options?: DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>, never, RuntimeContext>;
  /** Native embedded SQLite queries. */
  readonly sql: SqlStorage;
  /** Schedule an alarm, replacing and cancelling any previously armed event. */
  setAlarm(time: number | Date): Effect.Effect<void, never, RuntimeContext>;
  /** Read the armed timestamp in epoch milliseconds. */
  getAlarm(): Effect.Effect<number | null, never, RuntimeContext>;
  /** Cancel the native scheduled event and invalidate any racing delivery. */
  deleteAlarm(): Effect.Effect<void, never, RuntimeContext>;
}

const listEntries = <T>(
  kv: Record<string, unknown>,
  options?: DurableObjectListOptions,
): Map<string, T> => {
  let keys = Object.keys(kv).sort();
  if (options?.prefix !== undefined) {
    keys = keys.filter((key) => key.startsWith(options.prefix!));
  }
  if (options?.start !== undefined) {
    keys = keys.filter((key) => key >= options.start!);
  }
  if (options?.startAfter !== undefined) {
    keys = keys.filter((key) => key > options.startAfter!);
  }
  if (options?.end !== undefined) {
    keys = keys.filter((key) => key < options.end!);
  }
  if (options?.reverse) keys.reverse();
  if (options?.limit !== undefined) keys = keys.slice(0, options.limit);
  return new Map(keys.map((key) => [key, kv[key] as T]));
};

/** @internal No activation context is captured by storage operations. */
export const fromRivetStorage = (): DurableObjectStorage => {
  const alarmMutex = Semaphore.makeUnsafe(1);

  function get<T = unknown>(
    key: string,
  ): Effect.Effect<T | undefined, never, RuntimeContext>;
  function get<T = unknown>(
    keys: string[],
  ): Effect.Effect<Map<string, T>, never, RuntimeContext>;
  function get<T = unknown>(
    keys: string | string[],
  ): Effect.Effect<T | undefined | Map<string, T>, never, RuntimeContext> {
    return NativeContext.pipe(
      Effect.map(({ state }) =>
        Array.isArray(keys)
          ? new Map(
              keys
                .filter((key) => Object.hasOwn(state.kv, key))
                .map((key) => [key, state.kv[key] as T]),
            )
          : (state.kv[keys] as T | undefined),
      ),
    );
  }

  function remove(key: string): Effect.Effect<boolean, never, RuntimeContext>;
  function remove(keys: string[]): Effect.Effect<number, never, RuntimeContext>;
  function remove(
    keys: string | string[],
  ): Effect.Effect<boolean | number, never, RuntimeContext> {
    return NativeContext.pipe(
      Effect.map(({ state }) => {
        let deleted = 0;
        for (const key of typeof keys === "string" ? [keys] : keys) {
          if (Object.hasOwn(state.kv, key)) {
            delete state.kv[key];
            deleted++;
          }
        }
        return typeof keys === "string" ? deleted > 0 : deleted;
      }),
    );
  }

  return {
    get,
    put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      NativeContext.pipe(
        Effect.map(({ state }) => {
          if (typeof keyOrEntries === "string") {
            state.kv[keyOrEntries] = value;
          } else {
            Object.assign(state.kv, keyOrEntries);
          }
        }),
      ),
    delete: remove,
    deleteAll: () =>
      NativeContext.pipe(
        Effect.map(({ state }) => {
          state.kv = {};
        }),
      ),
    list: <T = unknown>(options?: DurableObjectListOptions) =>
      NativeContext.pipe(
        Effect.map(({ state }) => listEntries<T>(state.kv, options)),
      ),
    sql: {
      exec: <Row extends Record<string, unknown> = Record<string, unknown>>(
        query: string,
        ...bindings: unknown[]
      ) =>
        NativeContext.pipe(
          Effect.flatMap((native) =>
            Effect.promise(() => native.db.execute<Row>(query, ...bindings)),
          ),
        ),
    },
    setAlarm: (time) =>
      Effect.gen(function* () {
        const native = yield* NativeContext;
        const previous = native.state.alarm;
        const at = time instanceof Date ? time.getTime() : time;
        const generation = (native.state.alarmGeneration ?? 0) + 1;
        native.state.alarmGeneration = generation;
        native.state.alarm = { time: at, generation };
        const scheduleId = yield* Effect.promise(() =>
          native.schedule.at(at, ALARM_ACTION, generation),
        ).pipe(
          Effect.catchCause((cause) => {
            if (native.state.alarm?.generation === generation) {
              native.state.alarm = previous;
            }
            return Effect.failCause(cause);
          }),
        );
        if (native.state.alarm?.generation === generation) {
          native.state.alarm.scheduleId = scheduleId;
        } else {
          yield* Effect.promise(() => native.schedule.cancel(scheduleId));
        }
        if (previous?.scheduleId !== undefined) {
          yield* Effect.promise(() =>
            native.schedule.cancel(previous.scheduleId!),
          );
        }
      }).pipe(
        // Native scheduling cannot be aborted; settle its bookkeeping before release.
        Effect.uninterruptible,
        alarmMutex.withPermit,
      ),
    getAlarm: () =>
      NativeContext.pipe(Effect.map(({ state }) => state.alarm?.time ?? null)),
    deleteAlarm: () =>
      Effect.gen(function* () {
        const native = yield* NativeContext;
        const alarm = native.state.alarm;
        native.state.alarmGeneration = (native.state.alarmGeneration ?? 0) + 1;
        native.state.alarm = undefined;
        if (alarm?.scheduleId !== undefined) {
          yield* Effect.promise(() =>
            native.schedule.cancel(alarm.scheduleId!),
          );
        }
      }).pipe(Effect.uninterruptible, alarmMutex.withPermit),
  };
};
