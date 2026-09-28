import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { CallbackError } from "../../Callback.ts";
import { dispatchCallbacks } from "../CallbackDispatcher.ts";
import {
  makeCallbackFactory,
  makeCallbackRegistry,
  openCallbackRegistry,
  type CallbackJob,
  type CallbackRegistry,
  type CallbackStore,
} from "../CallbackRegistry.ts";
import {
  ensureAlarmTables,
  reconcileDurableObjectAlarm,
} from "./DurableObjectAlarmStorage.ts";
import { fromDurableObjectStorage } from "./DurableObjectStorage.ts";
import { ActiveStorageTransactions } from "./DurableObjectTransactionContext.ts";

type AlarmRow = {
  callback: string;
  id: string;
  version: string;
  run_at: number;
  payload: string;
};

const registries = new WeakMap<cf.DurableObjectState, CallbackRegistry>();

export const makeNativeCallbackStore = (
  raw: cf.DurableObjectStorage,
): CallbackStore => {
  const storage = fromDurableObjectStorage(raw);
  const transaction = <A, R>(
    callback: string,
    effect: Effect.Effect<A, never, R>,
  ) =>
    storage.transaction(effect).pipe(
      Effect.catchTag("DurableObjectStorageError", (cause) =>
        Effect.fail(
          new CallbackError({
            callback,
            message: "Callback storage transaction failed",
            cause,
          }),
        ),
      ),
    );
  const mutate = (callback: string, effect: Effect.Effect<unknown>) =>
    transaction(
      callback,
      Effect.gen(function* () {
        yield* ensureAlarmTables(raw);
        yield* effect;
        yield* reconcileDurableObjectAlarm(raw);
      }),
    );

  return {
    put: (job) =>
      mutate(
        job.callback,
        Effect.sync(() =>
          raw.sql.exec(
            `INSERT INTO alchemy_alarm_callbacks (callback, id, version, run_at, payload)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (callback, id) DO UPDATE SET
           version = excluded.version, run_at = excluded.run_at, payload = excluded.payload`,
            job.callback,
            job.id,
            job.version,
            job.runAt,
            job.payload,
          ),
        ),
      ),
    remove: (callback, id) =>
      mutate(
        callback,
        Effect.sync(() =>
          raw.sql.exec(
            "DELETE FROM alchemy_alarm_callbacks WHERE callback = ? AND id = ?",
            callback,
            id,
          ),
        ),
      ),
    prepare: (hasCallbacks, hasLegacyHandler) =>
      Effect.gen(function* () {
        if (!hasCallbacks) {
          const hasJobs = yield* Effect.sync(
            () =>
              raw.sql
                ?.exec(
                  "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('alchemy_alarm_callbacks', 'alchemy_alarm_schema', 'alchemy_scheduled_events')",
                )
                .toArray().length > 0,
          );
          if (!hasJobs) return false;
        }
        yield* ensureAlarmTables(raw);
        if (!hasLegacyHandler) {
          const legacy = yield* Effect.sync(() =>
            raw.sql
              .exec("SELECT id FROM alchemy_scheduled_events LIMIT 1")
              .toArray(),
          );
          if (legacy.length > 0) {
            return yield* Effect.fail(
              new CallbackError({
                callback: "scheduleEvent",
                message:
                  "Pending legacy events require an alarm handler calling processScheduledEvents",
              }),
            );
          }
        }
        return true;
      }),
    due: (now, limit) =>
      Effect.sync(() =>
        raw.sql
          .exec<AlarmRow>(
            `SELECT callback, id, version, run_at, payload FROM alchemy_alarm_callbacks
       WHERE run_at <= ? ORDER BY run_at, callback, id LIMIT ?`,
            now,
            limit,
          )
          .toArray()
          .map((row): CallbackJob => ({
            callback: row.callback,
            id: row.id,
            version: row.version,
            runAt: row.run_at,
            payload: row.payload,
          })),
      ),
    claim: (job, retryAt) =>
      transaction(
        job.callback,
        Effect.gen(function* () {
          const claimed = yield* Effect.sync(
            () =>
              raw.sql.exec(
                `UPDATE alchemy_alarm_callbacks SET run_at = ?
         WHERE callback = ? AND id = ? AND version = ?`,
                retryAt,
                job.callback,
                job.id,
                job.version,
              ).rowsWritten > 0,
          );
          yield* reconcileDurableObjectAlarm(raw);
          return claimed;
        }),
      ),
    acknowledge: (job) =>
      transaction(
        job.callback,
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
      ),
    sync: () => storage.sync(),
    reconcile: () => transaction("alarm", reconcileDurableObjectAlarm(raw)),
  };
};

const registryFor = (
  state: cf.DurableObjectState,
  omitContext: CallbackRegistry["omitContext"] = (context) => context,
) => {
  let registry = registries.get(state);
  if (!registry) {
    registry = makeCallbackRegistry(
      makeNativeCallbackStore(state.storage),
      (context) =>
        omitContext(context.pipe(Context.omit(ActiveStorageTransactions))),
    );
    registries.set(state, registry);
  }
  return registry;
};

export const initializeAlarmCallbacks = (state: cf.DurableObjectState) =>
  openCallbackRegistry(registryFor(state));

export const makeDurableObjectCallbackFactory = (
  state: cf.DurableObjectState,
  omitContext?: CallbackRegistry["omitContext"],
) => makeCallbackFactory(registryFor(state, omitContext));

export const dispatchAlarmCallbacks = (
  state: cf.DurableObjectState,
  hasLegacyHandler: boolean,
) => {
  const registry = registries.get(state);
  return registry ? dispatchCallbacks(registry, hasLegacyHandler) : Effect.void;
};
