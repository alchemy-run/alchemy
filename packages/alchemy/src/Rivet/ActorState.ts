/**
 * `DurableObjectState` / `DurableObjectStorage` implemented over a Rivet
 * actor.
 *
 * This is where the shared Durable Object interface meets a runtime that
 * is not workerd. The mapping, all of it verified against a live engine:
 *
 * | Durable Object            | Rivet                                    |
 * |---------------------------|------------------------------------------|
 * | `storage.get/put/delete`  | `c.state.kv` (auto-persisted state)      |
 * | `storage.list`            | in-memory scan of `c.state.kv`           |
 * | `storage.sql.exec`        | `c.db.execute` (per-actor SQLite)        |
 * | `storage.setAlarm`        | `c.schedule.at(time, ALARM_ACTION)`      |
 * | `storage.getAlarm`        | timestamp mirrored in `c.state.alarm`    |
 * | `storage.deleteAlarm`     | generation guard (see below)             |
 * | `blockConcurrencyWhile`   | runs the callback (see the caveat below)  |
 *
 * **`deleteAlarm` without native cancellation.** Rivet's `c.schedule`
 * exposes no cancel, so a scheduled action always fires. The alarm time
 * and a monotonically increasing generation live in the actor's state;
 * the fired action compares its generation against the stored one and
 * no-ops when it has been superseded or cleared. Observable semantics
 * match Durable Objects; the only cost is a wakeup that does nothing.
 *
 * **Concurrency caveat.** Durable Objects serialize requests behind input
 * gates. Rivet runs actions in PARALLEL by default, so
 * `blockConcurrencyWhile` cannot reproduce the exclusivity it grants on
 * workerd — it runs the callback and nothing more. Code that depends on
 * cross-request serialization needs Rivet's queue/`run` loop instead.
 * Likewise `c.state` persists on a ~1s write-behind throttle rather than
 * per-request, so it has no equivalent of workerd's output gate.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { DurableObjectStorage } from "../Cloudflare/Workers/DurableObjectStorage.ts";

/** The reserved Rivet action the bridge registers to deliver alarms. */
export const ALARM_ACTION = "__alchemyAlarm";

/** The shape an adapted actor keeps its Durable Object state under. */
export interface RivetActorState {
  kv: Record<string, unknown>;
  /** Scheduled alarm time (epoch ms) and its generation, when armed. */
  alarm?: { time: number; generation: number };
  /** Monotonic counter; a fired alarm whose generation is stale no-ops. */
  alarmGeneration?: number;
}

const listEntries = (
  kv: Record<string, unknown>,
  options?: {
    start?: string;
    startAfter?: string;
    end?: string;
    prefix?: string;
    reverse?: boolean;
    limit?: number;
  },
): Map<string, any> => {
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
  if (options?.reverse) {
    keys.reverse();
  }
  if (options?.limit !== undefined) {
    keys = keys.slice(0, options.limit);
  }
  return new Map(keys.map((key) => [key, kv[key]]));
};

/**
 * A {@link SqlCursor}-shaped view over one `c.db.execute` result.
 *
 * Cloudflare's `exec` runs the query and hands back a cursor whose
 * `columnNames` is a plain array, so the rows must already be in hand —
 * hence the cursor is built from a materialized array, not a promise. It
 * is simultaneously a `Stream` of rows (spread from the Stream prototype)
 * and carries the method-shaped helpers.
 */
const makeCursor = (rows: any[]) => {
  let cursorIndex = 0;
  return Object.assign(Stream.fromIterable(rows), {
    next: () =>
      Effect.sync(() =>
        cursorIndex < rows.length
          ? { done: false as const, value: rows[cursorIndex++] }
          : { done: true as const },
      ),
    toArray: () => Effect.succeed(rows),
    one: () =>
      rows.length === 1
        ? Effect.succeed(rows[0])
        : Effect.die(
            new Error(
              `Expected exactly one row from SQL query, got ${rows.length}`,
            ),
          ),
    raw: () => Stream.fromIterable(rows.map((row) => Object.values(row))),
    columnNames: rows.length > 0 ? Object.keys(rows[0]) : [],
    rowsRead: Effect.succeed(rows.length),
    rowsWritten: Effect.succeed(0),
  });
};

/**
 * Build a {@link DurableObjectStorage} view over a Rivet actor context.
 * Mutations write straight through — Rivet persists the state object
 * itself, so there is no explicit flush.
 */
export const fromRivetState = (c: {
  state: RivetActorState;
  db?: { execute: (query: string, ...bindings: any[]) => Promise<any[]> };
  schedule?: { at: (time: number, action: string, ...args: any[]) => any };
}): DurableObjectStorage => {
  const kv = () => (c.state.kv ??= {});

  const get = (keyOrKeys: string | string[]) =>
    Effect.sync(() =>
      Array.isArray(keyOrKeys)
        ? new Map(
            keyOrKeys
              .filter((key) => key in kv())
              .map((key) => [key, kv()[key]]),
          )
        : (kv()[keyOrKeys] as any),
    );

  const put = (keyOrEntries: string | Record<string, unknown>, value?: any) =>
    Effect.sync(() => {
      if (typeof keyOrEntries === "string") {
        kv()[keyOrEntries] = value;
      } else {
        Object.assign(kv(), keyOrEntries);
      }
    });

  const remove = (keyOrKeys: string | string[]) =>
    Effect.sync(() => {
      const store = kv();
      if (Array.isArray(keyOrKeys)) {
        let deleted = 0;
        for (const key of keyOrKeys) {
          if (key in store) {
            delete store[key];
            deleted++;
          }
        }
        return deleted;
      }
      const existed = keyOrKeys in store;
      delete store[keyOrKeys];
      return existed;
    });

  const requireDb = () => {
    if (c.db === undefined) {
      throw new Error(
        "SQL storage is unavailable: this actor was registered without a " +
          "database. The Rivet bridge declares one for every Durable " +
          "Object, so this indicates a bridge bug.",
      );
    }
    return c.db;
  };

  return {
    get,
    put,
    delete: remove,
    deleteAll: () =>
      Effect.sync(() => {
        c.state.kv = {};
      }),
    list: (options?: any) => Effect.sync(() => listEntries(kv(), options)),
    // Rivet actions are NOT serialized (see the module doc) — this runs the
    // callback without the exclusivity workerd's input gates provide.
    blockConcurrencyWhile: (callback: any) => callback(),
    sync: () => Effect.void,

    sql: {
      // Matches Cloudflare: running the effect ISSUES the query, and the
      // resolved cursor is already materialized.
      exec: (query: string, ...bindings: any[]) =>
        Effect.promise(() => requireDb().execute(query, ...bindings)).pipe(
          Effect.map(makeCursor),
        ),
    },

    setAlarm: (time: number | Date) =>
      Effect.sync(() => {
        const at = time instanceof Date ? time.getTime() : time;
        const generation = (c.state.alarmGeneration ?? 0) + 1;
        c.state.alarmGeneration = generation;
        c.state.alarm = { time: at, generation };
        // No native cancel: the fired action checks this generation.
        c.schedule?.at(at, ALARM_ACTION, generation);
      }),
    getAlarm: () => Effect.sync(() => c.state.alarm?.time ?? null),
    deleteAlarm: () =>
      Effect.sync(() => {
        // Bump the generation so the pending wakeup is superseded.
        c.state.alarmGeneration = (c.state.alarmGeneration ?? 0) + 1;
        c.state.alarm = undefined;
      }),

    transaction: () =>
      Effect.die(
        new Error(
          "Storage transactions are not available on the Rivet engine — " +
            "use `storage.sql` (per-actor SQLite) for atomic multi-step " +
            "writes, or serialize through a Rivet queue.",
        ),
      ),
    getCurrentBookmark: () => unsupportedBookmarks,
    getBookmarkForTime: () => unsupportedBookmarks,
    onNextSessionRestoreBookmark: () => unsupportedBookmarks,
    get kv(): never {
      throw new Error(
        "The raw synchronous KV handle is workerd-specific — use the " +
          "`state.storage` Effect API.",
      );
    },
  } as unknown as DurableObjectStorage;
};

const unsupportedBookmarks = Effect.die(
  new Error(
    "Storage bookmarks are a workerd point-in-time-recovery feature with " +
      "no Rivet equivalent.",
  ),
);

/**
 * Decide whether a fired alarm is still current. Called by the bridge's
 * reserved alarm action before dispatching to the user's `alarm` handler.
 */
export const isAlarmCurrent = (
  state: RivetActorState,
  generation: number,
): boolean => state.alarm?.generation === generation;

/** Clear the armed alarm after it fires (matching Durable Object semantics). */
export const consumeAlarm = (state: RivetActorState): void => {
  state.alarm = undefined;
};
