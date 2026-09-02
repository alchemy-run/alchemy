/**
 * The Rivet flavor of the engine-invariant Durable Object core: what a
 * Rivet-hosted `Cloudflare.DurableObject` declaration binds onto its
 * worker, the gateway-backed namespace stub, and `DurableObjectState`
 * implemented over a rivetkit actor (persisted state, per-actor SQLite,
 * the scheduler).
 *
 * The mapping, all of it verified against a live engine:
 *
 * | Durable Object            | Rivet                                    |
 * |---------------------------|------------------------------------------|
 * | `storage.get/put/delete`  | `c.state.kv` (auto-persisted state)      |
 * | `storage.list`            | in-memory scan of `c.state.kv`           |
 * | `storage.sql.exec`        | `c.db.execute` (per-actor SQLite)        |
 * | `storage.setAlarm`        | `c.schedule.at(time, ALARM_ACTION)`      |
 * | `storage.getAlarm`        | timestamp mirrored in `c.state.alarm`    |
 * | `storage.deleteAlarm`     | generation guard (see below)             |
 * | `acceptWebSocket`         | per-actor socket registry                |
 * | `blockConcurrencyWhile`   | runs the callback (see the caveat below) |
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
 * workerd — it runs the callback and nothing more. Likewise `c.state`
 * persists on a write-behind throttle rather than per-request, so it has
 * no equivalent of workerd's output gate.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  DurableObjectBindingDeclaration,
  DurableObjectState,
  DurableObjectStubLike,
} from "../Workers/DurableObject.ts";
import type { DurableObjectStorage } from "../Workers/DurableObjectStorage.ts";
import {
  fromWebSocket,
  type RawWebSocket,
  type WebSocket,
} from "../Workers/WebSocket.ts";

/**
 * Rivet's worker binding contract carries plain Durable Object
 * declarations, not Cloudflare's `bindings` array.
 */
export const durableObjectBinding = (
  decl: DurableObjectBindingDeclaration,
) => ({
  durableObjects: [{ name: decl.name, className: decl.className }],
});

/**
 * The runner's synthetic environment (see `WorkerBridge.ts`) already maps
 * each hosted class to a gateway-backed namespace, so the "native stub" IS
 * the finished stub.
 */
export const durableObjectStub = (nativeStub: DurableObjectStubLike) =>
  nativeStub;

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

/** The subset of a rivetkit actor context the state service reads. */
export interface RivetActorContext {
  readonly state: RivetActorState;
  /** The actor key — Rivet's instance identity (the Durable Object name). */
  readonly key?: readonly string[] | string;
  readonly name?: string;
  /** `rivetkit/db`'s per-actor SQLite client, when the actor declares one. */
  readonly db?: {
    execute: (query: string, ...bindings: unknown[]) => Promise<unknown[]>;
  };
  readonly schedule?: {
    at: (time: number, action: string, ...args: unknown[]) => unknown;
  };
}

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
): Map<string, unknown> => {
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
 * A `SqlCursor`-shaped view over one `c.db.execute` result. Cloudflare's
 * `exec` runs the query and hands back a cursor whose `columnNames` is a
 * plain array, so the rows are materialized before the cursor exists. It
 * is simultaneously a `Stream` of rows and carries the cursor helpers.
 */
const makeCursor = (rows: Record<string, unknown>[]) => {
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

const unsupportedBookmarks = Effect.die(
  new Error(
    "Storage bookmarks are a workerd point-in-time-recovery feature with " +
      "no Rivet equivalent.",
  ),
);

const unsupportedAutoResponse = Effect.die(
  new Error(
    "WebSocket auto-response has no Rivet equivalent — handle the ping in " +
      "`webSocketMessage`.",
  ),
);

/**
 * `DurableObjectStorage` over a rivetkit actor. Mutations write straight
 * through — Rivet persists the state object itself, so there is no
 * explicit flush. `current` resolves the actor context lazily so the
 * storage built once at actor start follows the latest per-call context.
 */
const fromRivetStorage = (
  current: () => RivetActorContext,
): DurableObjectStorage => {
  const kv = () => (current().state.kv ??= {});

  const requireDb = () => {
    const db = current().db;
    if (db === undefined) {
      throw new Error(
        "SQL storage is unavailable: this actor was registered without a " +
          "database. The Rivet bridge declares one for every Durable " +
          "Object, so this indicates a bridge bug.",
      );
    }
    return db;
  };

  return {
    get: (keyOrKeys: string | string[]) =>
      Effect.sync(() =>
        Array.isArray(keyOrKeys)
          ? new Map(
              keyOrKeys
                .filter((key) => key in kv())
                .map((key) => [key, kv()[key]]),
            )
          : kv()[keyOrKeys],
      ),
    put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      Effect.sync(() => {
        if (typeof keyOrEntries === "string") {
          kv()[keyOrEntries] = value;
        } else {
          Object.assign(kv(), keyOrEntries);
        }
      }),
    delete: (keyOrKeys: string | string[]) =>
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
      }),
    deleteAll: () =>
      Effect.sync(() => {
        current().state.kv = {};
      }),
    list: (options?: Parameters<typeof listEntries>[1]) =>
      Effect.sync(() => listEntries(kv(), options)),
    // Rivet actions are NOT serialized (see the module doc) — this runs the
    // callback without the exclusivity workerd's input gates provide.
    blockConcurrencyWhile: (callback: () => Effect.Effect<unknown>) =>
      callback(),
    sync: () => Effect.void,
    sql: {
      // Matches Cloudflare: running the effect ISSUES the query, and the
      // resolved cursor is already materialized.
      exec: (query: string, ...bindings: unknown[]) =>
        Effect.promise(() => requireDb().execute(query, ...bindings)).pipe(
          Effect.map((rows) => makeCursor(rows as Record<string, unknown>[])),
        ),
    },
    setAlarm: (time: number | Date) =>
      Effect.sync(() => {
        const c = current();
        const at = time instanceof Date ? time.getTime() : time;
        const generation = (c.state.alarmGeneration ?? 0) + 1;
        c.state.alarmGeneration = generation;
        c.state.alarm = { time: at, generation };
        // No native cancel: the fired action checks this generation.
        c.schedule?.at(at, ALARM_ACTION, generation);
      }),
    getAlarm: () => Effect.sync(() => current().state.alarm?.time ?? null),
    deleteAlarm: () =>
      Effect.sync(() => {
        const c = current();
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

/**
 * `DurableObjectState` over a rivetkit actor. Built ONCE per actor
 * instance (see `DurableObjectBridge.ts`); `current` follows the latest
 * per-call context and `sockets` is the actor's WebSocket registry —
 * ephemeral by design: workerd rebuilds its socket set after a hibernation
 * wake, and Rivet re-delivers through `onWebSocket`.
 */
export const fromRivetActor = (
  current: () => RivetActorContext,
  sockets: Map<RawWebSocket, string[]>,
): DurableObjectState["Service"] => {
  const c = current();
  return {
    // Rivet addresses actors by key; expose it where workerd exposes the
    // Durable Object id.
    id: {
      toString: () =>
        String((Array.isArray(c.key) ? c.key[0] : c.key) ?? c.name ?? ""),
    } as unknown as DurableObjectState["Service"]["id"],
    storage: fromRivetStorage(current),
    get raw() {
      return current() as unknown as DurableObjectState["Service"]["raw"];
    },
    // Rivet keeps the actor alive for its own task; run detached from the
    // caller's response.
    waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();
        yield* Effect.sync(() => {
          void Effect.runPromise(
            effect.pipe(
              Effect.provide(context),
              Effect.catchCause(() => Effect.void),
            ),
          );
        });
      }),
    // Rivet actions are not serialized (see the module doc) — this runs the
    // callback without workerd's input-gate exclusivity.
    blockConcurrencyWhile: (callback) => callback(),
    acceptWebSocket: (ws: WebSocket, tags?: string[]) =>
      Effect.sync(() => {
        sockets.set(ws.ws, tags ?? []);
      }),
    getWebSockets: (tag?: string) =>
      Effect.sync(() =>
        [...sockets.entries()]
          .filter(([, tags]) => tag === undefined || tags.includes(tag))
          .map(([ws]) => fromWebSocket(ws)),
      ),
    getTags: (ws) => Effect.sync(() => sockets.get(ws) ?? []),
    // Rivet has no auto-response or per-socket event timeout knob.
    setWebSocketAutoResponse: () => unsupportedAutoResponse,
    getWebSocketAutoResponse: () => Effect.succeed(null),
    getWebSocketAutoResponseTimestamp: () => Effect.succeed(null),
    setHibernatableWebSocketEventTimeout: () => Effect.void,
    getHibernatableWebSocketEventTimeout: () => Effect.succeed(null),
    abort: () => Effect.void,
  };
};
