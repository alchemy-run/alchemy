import type * as cf from "@cloudflare/workers-types";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Move a SQLite-backed Durable Object's storage to another object while it
 * keeps serving, then hand over in one short, atomic step.
 *
 * The **source** (the object that holds the data) keeps running its own code.
 * Once a move begins it logs every key-value write, in order, next to the
 * write itself. The **target** (the object the data moves to) copies the
 * source's key-value entries in the background, page by page, then reads the
 * log to catch up on what changed meanwhile. When little is left it holds its
 * own calls and asks the source to **seal**: the source stops taking calls,
 * waits for the ones under way and its background work to finish, cancels
 * its alarm, and refuses any write after. The target then reads the last of
 * the log and the SQL tables (alarm callbacks live there) and owns the data.
 *
 * At every moment exactly one of the two serves a key: the source until it
 * seals, the target after. Every step can be repeated: the target records
 * where it got to, and the source's log and seal are idempotent.
 *
 * @internal
 */

/**
 * An instance member that tells the bridge not to run the object's stored
 * alarm callbacks: the instance's `alarm` handles the alarm instead. A
 * target set it until it owns the data, so callbacks copied from the source
 * don't run twice.
 */
export const OwnsAlarmCallbacks = "~alchemy/ownsAlarmCallbacks";

/** Keys a move keeps in the source's and target's storage: never copied. */
export const MOVE_PREFIX = "~move:";
/** Keys an earlier transfer kept: never copied. */
const TRANSFER_PREFIX = "~transfer:";
const isInternal = (key: string) => key.startsWith(MOVE_PREFIX) || key.startsWith(TRANSFER_PREFIX);

const TRACKING = `${MOVE_PREFIX}tracking`;
const SEQ = `${MOVE_PREFIX}seq`;
const SEALED = `${MOVE_PREFIX}sealed`;
const logKey = (seq: number) => `${MOVE_PREFIX}s:${String(seq).padStart(16, "0")}`;
const LOG_PREFIX = `${MOVE_PREFIX}s:`;
const lastKey = (key: string) => `${MOVE_PREFIX}k:${key}`;

/** Key-value entries per page: at most 128 KiB each, so a page stays well under RPC's 32 MiB. */
export const KV_PAGE = 128;
/** Rows per SQL page, cut short once they pass {@link PAGE_BYTES}. */
const SQL_PAGE = 200;
const PAGE_BYTES = 8 * 1024 * 1024;
/** How long a seal waits for the calls under way and background work to finish. */
const SEAL_WAIT_MS = 20_000;

/** A write to a sealed object: its data has moved. The call fails; its caller tries the new object. */
export class ObjectMoved extends Data.TaggedError("ObjectMoved")<{ readonly message: string }> {}

/** A seal that couldn't finish: calls or background work on the source didn't end in time. */
export class SealTimeout extends Data.TaggedError("SealTimeout")<{ readonly message: string }> {}

// ---------------------------------------------------------------- source

interface Source {
  seq: number;
  /** Set when a seal starts: new calls go to the target. */
  sealing: boolean;
  /** Set once the seal is done: every write is refused. */
  sealed: boolean;
  readonly proxy: cf.DurableObjectStorage;
}

const sources = new WeakMap<cf.DurableObjectStorage, Source>();

/**
 * Calls, alarms and background work under way on each object that may become
 * a source, counted from the moment it is constructed (see `watchSource`): a
 * call that began before its move did must hold up the seal as much as one
 * that began after.
 */
const activity = new WeakMap<cf.DurableObjectStorage, { inflight: number }>();

/**
 * The storage an object's code should write through: the raw storage, or, on
 * a source being moved, a view that logs every key-value write. Read on every
 * call, so a wrapper made before the move began logs too.
 */
export const liveStorage = (raw: cf.DurableObjectStorage): cf.DurableObjectStorage =>
  sources.get(raw)?.proxy ?? raw;

/** Count `promise` as work under way on a source (its `waitUntil` work): a seal waits for it. */
export const trackWork = <A>(raw: cf.DurableObjectStorage, promise: Promise<A>): Promise<A> => {
  const counter = activity.get(raw);
  if (counter === undefined) return promise;
  counter.inflight += 1;
  return promise.finally(() => {
    counter.inflight -= 1;
  });
};

/** Run `effect` as a call under way on a source: a seal waits for it. */
export const counted = <A, E, R>(raw: cf.DurableObjectStorage, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const counter = activity.get(raw);
    if (counter === undefined) return effect;
    counter.inflight += 1;
    return Effect.ensuring(
      effect,
      Effect.sync(() => {
        counter.inflight -= 1;
      }),
    );
  });

/** Whether calls to this object should go to its target: a seal has started. */
export const isSealing = (raw: cf.DurableObjectStorage) => {
  const source = sources.get(raw);
  return source !== undefined && (source.sealing || source.sealed);
};

const moved = () =>
  new ObjectMoved({ message: "This Durable Object's data has moved to another object" });

/** The log entries for writes to `keys`: each key's latest sequence, and the order. */
const logFor = (source: Source, keys: ReadonlyArray<string>) => {
  const log: Record<string, unknown> = {};
  for (const key of keys) {
    if (isInternal(key)) continue;
    const seq = ++source.seq;
    log[logKey(seq)] = key;
    log[lastKey(key)] = seq;
  }
  if (Object.keys(log).length > 0) log[SEQ] = source.seq;
  return log;
};

/** `entries` as `put` batches of at most 128. */
const batches = (entries: Record<string, unknown>) => {
  const all = Object.entries(entries);
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < all.length; i += 128) out.push(Object.fromEntries(all.slice(i, i + 128)));
  return out;
};

/**
 * Issue `write` and its log together, without awaiting anything between:
 * Durable Objects commit writes made in one turn atomically.
 */
const withLog = <A>(
  target: { put: (entries: Record<string, unknown>) => Promise<void> },
  source: Source,
  keys: ReadonlyArray<string>,
  write: () => Promise<A>,
): Promise<A> => {
  if (source.sealed) return Promise.reject(moved());
  const result = write();
  const logged = batches(logFor(source, keys)).map((batch) => target.put(batch));
  return Promise.all([result, ...logged]).then(([value]) => value as A);
};

const trackedKv = (kv: cf.SyncKvStorage, source: Source): cf.SyncKvStorage =>
  new Proxy(kv, {
    get: (target, prop) => {
      if (prop === "put")
        return (key: string, value: unknown) => {
          if (source.sealed) throw moved();
          target.put(key, value);
          for (const [k, v] of Object.entries(logFor(source, [key]))) target.put(k, v);
        };
      if (prop === "delete")
        return (key: string) => {
          if (source.sealed) throw moved();
          const deleted = target.delete(key);
          for (const [k, v] of Object.entries(logFor(source, [key]))) target.put(k, v);
          return deleted;
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const trackedTxn = (
  txn: cf.DurableObjectTransaction,
  source: Source,
): cf.DurableObjectTransaction =>
  new Proxy(txn, {
    get: (target, prop) => {
      if (prop === "put")
        return (keyOrEntries: string | Record<string, unknown>, value?: unknown, options?: any) =>
          typeof keyOrEntries === "string"
            ? withLog(target, source, [keyOrEntries], () =>
                target.put(keyOrEntries, value, options),
              )
            : withLog(target, source, Object.keys(keyOrEntries), () =>
                target.put(keyOrEntries, value as any),
              );
      if (prop === "delete")
        return (keys: string | string[], options?: any) =>
          withLog(target, source, typeof keys === "string" ? [keys] : keys, () =>
            target.delete(keys as any, options),
          );
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** A view of `raw` that logs every key-value write while it is a source, and refuses writes once sealed. */
const tracked = (raw: cf.DurableObjectStorage, source: () => Source): cf.DurableObjectStorage =>
  new Proxy(raw, {
    get: (target, prop) => {
      const s = source();
      switch (prop) {
        case "put":
          return (
            keyOrEntries: string | Record<string, unknown>,
            value?: unknown,
            options?: any,
          ) =>
            typeof keyOrEntries === "string"
              ? withLog(target, s, [keyOrEntries], () => target.put(keyOrEntries, value, options))
              : withLog(target, s, Object.keys(keyOrEntries), () =>
                  target.put(keyOrEntries, value as any),
                );
        case "delete":
          return (keys: string | string[], options?: any) =>
            withLog(target, s, typeof keys === "string" ? [keys] : keys, () =>
              target.delete(keys as any, options),
            );
        case "deleteAll":
          // Nothing an object being moved does empties itself: refuse, rather than
          // lose the move's log with it.
          return () => Promise.reject(moved());
        case "transaction":
          return (body: (txn: cf.DurableObjectTransaction) => Promise<unknown>) =>
            s.sealed
              ? Promise.reject(moved())
              : target.transaction((txn) => body(trackedTxn(txn, s)));
        case "kv":
          return trackedKv(target.kv, s);
        case "sql":
          return s.sealed
            ? new Proxy(target.sql, {
                get: (sql, key) =>
                  key === "exec"
                    ? (query: string, ...bindings: Array<unknown>) => {
                        if (!/^\s*(select|pragma)\b/i.test(query)) throw moved();
                        return sql.exec(query, ...(bindings as any));
                      }
                    : Reflect.get(sql, key),
              })
            : target.sql;
        case "setAlarm":
          return (...args: Array<unknown>) =>
            s.sealed ? Promise.reject(moved()) : (target.setAlarm as any)(...args);
        default: {
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });

/**
 * Watch an object that may become a source: count its work from now on, and
 * register it as a source if a move already began on it (it is logging), so a
 * restart keeps logging. Call when the object is constructed: it reads
 * storage synchronously.
 */
export const watchSource = (raw: cf.DurableObjectStorage) => {
  if (!activity.has(raw)) activity.set(raw, { inflight: 0 });
  if (sources.has(raw) || raw.kv.get(TRACKING) !== true) return;
  register(raw, raw.kv.get<boolean>(SEALED) === true);
};

const register = (raw: cf.DurableObjectStorage, sealed: boolean) => {
  let source: Source;
  source = {
    seq: raw.kv.get<number>(SEQ) ?? 0,
    sealing: sealed,
    sealed,
    proxy: tracked(raw, () => source),
  };
  if (!activity.has(raw)) activity.set(raw, { inflight: 0 });
  sources.set(raw, source);
  return source;
};

/**
 * Start logging writes, if not already: from here on, every change is in the
 * log. Answers where the log is now, which the target's copy starts after.
 */
export const beginSource = (raw: cf.DurableObjectStorage) =>
  Effect.sync(() => {
    if (raw.kv.get(TRACKING) !== true) {
      raw.kv.put(TRACKING, true);
      raw.kv.put(SEQ, 0);
    }
    return (sources.get(raw) ?? register(raw, raw.kv.get<boolean>(SEALED) === true)).seq;
  });

/** Where a snapshot page starts: after this key. */
export type SnapshotCursor = string | null;

export interface SnapshotPage {
  readonly entries: ReadonlyArray<readonly [string, unknown]>;
  /** The next page, or `null` once every entry has been read. */
  readonly next: SnapshotCursor;
}

/** A page of the source's key-value entries as they are now. */
export const snapshotPage = (raw: cf.DurableObjectStorage, after: SnapshotCursor) =>
  Effect.promise(async (): Promise<SnapshotPage> => {
    const listed = await raw.list(
      after === null ? { limit: KV_PAGE } : { limit: KV_PAGE, startAfter: after },
    );
    const keys = [...listed.keys()];
    return {
      entries: [...listed.entries()].filter(([key]) => !isInternal(key)),
      next: listed.size === KV_PAGE ? keys.at(-1)! : null,
    };
  });

export interface ChangesPage {
  /** Each changed key and its value now, or `deleted`. */
  readonly entries: ReadonlyArray<
    readonly [key: string, change: { readonly value: unknown } | "deleted"]
  >;
  /** The log position read through: ask for the next page after it. */
  readonly through: number;
  /** Whether the log goes on past this page. */
  readonly more: boolean;
}

/**
 * The keys written after log position `after`, with their values now. A key
 * written again later appears once, at its latest position. Reads storage
 * only, so no other event runs between its reads.
 */
export const changesPage = (raw: cf.DurableObjectStorage, after: number) =>
  Effect.promise(async (): Promise<ChangesPage> => {
    const logged = await raw.list<string>({
      prefix: LOG_PREFIX,
      startAfter: logKey(after),
      limit: KV_PAGE,
    });
    const rows = [...logged.entries()].map(
      ([key, changed]) => [Number(key.slice(LOG_PREFIX.length)), changed] as const,
    );
    const latest = await raw.get<number>(rows.map(([, changed]) => lastKey(changed)));
    const current = rows.filter(([seq, changed]) => latest.get(lastKey(changed)) === seq);
    const values = await raw.get(current.map(([, changed]) => changed));
    return {
      entries: current.map(([, changed]) => [
        changed,
        values.has(changed) ? { value: values.get(changed) } : "deleted",
      ]),
      through: rows.length > 0 ? rows.at(-1)![0] : after,
      more: logged.size === KV_PAGE,
    };
  });

/**
 * Seal the source: from here every call goes to the target, and once the
 * calls and background work under way have finished, every write is refused.
 * Answers the source's alarm, which the target takes over. Repeating it
 * answers the same.
 */
export const seal = (raw: cf.DurableObjectStorage, sockets: () => ReadonlyArray<WebSocketLike>) =>
  Effect.gen(function* () {
    const source = sources.get(raw) ?? register(raw, false);
    if (!source.sealed) {
      source.sealing = true;
      const started = yield* Clock.currentTimeMillis;
      const counter = activity.get(raw)!;
      // This call itself isn't counted (see `counted`): wait for everything else.
      while (counter.inflight > 0) {
        if ((yield* Clock.currentTimeMillis) - started > SEAL_WAIT_MS) {
          source.sealing = false;
          return yield* new SealTimeout({
            message: `${counter.inflight} calls or background tasks were still running after ${SEAL_WAIT_MS}ms`,
          });
        }
        yield* Effect.sleep("5 millis");
      }
      const alarm = yield* Effect.promise(() => raw.getAlarm());
      yield* Effect.promise(() => raw.put({ [SEALED]: true, [`${MOVE_PREFIX}alarm`]: alarm }));
      yield* Effect.promise(() => raw.deleteAlarm());
      source.sealed = true;
      for (const socket of sockets()) {
        try {
          socket.close(1012, "moved");
        } catch {
          // already closed
        }
      }
    }
    return {
      alarm: (yield* Effect.promise(() => raw.get<number | null>(`${MOVE_PREFIX}alarm`))) ?? null,
    };
  });

/** What `seal` closes: an accepted WebSocket. */
interface WebSocketLike {
  close(code?: number, reason?: string): void;
}

/**
 * Empty the source, once the target owns its data. It keeps one key, that it
 * is sealed, so a late call (from code still deploying) is sent to the
 * target, never served from an empty object.
 */
export const finish = (raw: cf.DurableObjectStorage) =>
  Effect.promise(async () => {
    await raw.deleteAlarm();
    await raw.deleteAll();
    await raw.put({ [TRACKING]: true, [SEALED]: true });
  });

// ---------------------------------------------------------------- SQL

/** Where the next SQL page starts. */
export interface SqlCursor {
  readonly table: number;
  readonly offset: number;
}

export interface SqlPage {
  /** The user tables and indexes, as `CREATE` statements: on the first page. */
  readonly schema?: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  readonly rows?: {
    readonly table: string;
    readonly columns: ReadonlyArray<string>;
    readonly values: ReadonlyArray<ReadonlyArray<unknown>>;
  };
  readonly next: SqlCursor | null;
}

/** Tables and indexes Cloudflare and SQLite own. */
const userObjects = (sql: cf.SqlStorage) =>
  sql
    .exec<{ name: string; sql: string; type: string }>(
      "SELECT name, sql, type FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index') AND substr(name, 1, 4) != '_cf_' AND substr(name, 1, 7) != 'sqlite_' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid",
    )
    .toArray();

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A row's size, roughly, as RPC sends it. */
const sizeOf = (row: ReadonlyArray<unknown>) => {
  let size = 0;
  for (const value of row)
    size +=
      typeof value === "string"
        ? value.length * 2
        : value instanceof ArrayBuffer
          ? value.byteLength
          : 8;
  return size;
};

/** A page of the source's SQL tables. Read once the source is sealed: they don't change. */
export const sqlPage = (raw: cf.DurableObjectStorage, at: SqlCursor | null) =>
  Effect.sync((): SqlPage => {
    const cursor = at ?? { table: 0, offset: 0 };
    const objects = userObjects(raw.sql);
    const tables = objects.filter((object) => object.type === "table");
    const schema =
      cursor.table === 0 && cursor.offset === 0
        ? objects.map(({ name, sql }) => ({ name, sql }))
        : undefined;
    const table = tables[cursor.table];
    if (table === undefined) return { ...(schema ? { schema } : {}), next: null };
    const result = raw.sql.exec(
      `SELECT * FROM ${quote(table.name)} LIMIT ? OFFSET ?`,
      SQL_PAGE,
      cursor.offset,
    );
    const rows = Array.from(result.raw()) as Array<Array<unknown>>;
    const values: Array<Array<unknown>> = [];
    let bytes = 0;
    for (const row of rows) {
      if (values.length > 0 && bytes + sizeOf(row) > PAGE_BYTES) break;
      values.push(row);
      bytes += sizeOf(row);
    }
    return {
      ...(schema ? { schema } : {}),
      rows: { table: table.name, columns: result.columnNames, values },
      next:
        values.length < rows.length || rows.length === SQL_PAGE
          ? { table: cursor.table, offset: cursor.offset + values.length }
          : { table: cursor.table + 1, offset: 0 },
    };
  });

// ---------------------------------------------------------------- target

/** Write key-value entries into the target. Safe to repeat. */
export const putEntries = (
  raw: cf.DurableObjectStorage,
  entries: ReadonlyArray<readonly [string, unknown]>,
) =>
  Effect.promise(async () => {
    for (let i = 0; i < entries.length; i += 128)
      await raw.put(Object.fromEntries(entries.slice(i, i + 128)));
  });

/** Apply a page of changes to the target. Safe to repeat. */
export const applyChanges = (raw: cf.DurableObjectStorage, page: ChangesPage) =>
  Effect.promise(async () => {
    const puts: Array<readonly [string, unknown]> = [];
    const deletes: Array<string> = [];
    for (const [key, change] of page.entries)
      if (change === "deleted") deletes.push(key);
      else puts.push([key, change.value]);
    for (let i = 0; i < puts.length; i += 128)
      await raw.put(Object.fromEntries(puts.slice(i, i + 128)));
    for (let i = 0; i < deletes.length; i += 128) await raw.delete(deletes.slice(i, i + 128));
  });

/** Write a SQL page into the target. Safe to repeat: tables that exist are kept, rows written over. */
export const putSql = (raw: cf.DurableObjectStorage, page: SqlPage) =>
  Effect.sync(() => {
    if (page.schema !== undefined) {
      const existing = new Set(userObjects(raw.sql).map((object) => object.name));
      for (const { name, sql } of page.schema) if (!existing.has(name)) raw.sql.exec(sql);
    }
    if (page.rows !== undefined && page.rows.values.length > 0) {
      const { table, columns, values } = page.rows;
      const insert = `INSERT OR REPLACE INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      raw.transactionSync(() => {
        for (const row of values) raw.sql.exec(insert, ...(row as Array<any>));
      });
    }
  });

/**
 * Arm the target's alarm for the stored callbacks that came over, or for the
 * source's own alarm if it had none.
 */
export const rearm = (raw: cf.DurableObjectStorage, alarm: number | null) =>
  Effect.gen(function* () {
    const next = yield* Effect.sync(() => {
      let next: number | null = null;
      for (const { name } of raw.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('alchemy_alarm_callbacks', 'alchemy_scheduled_events')",
        )
        .toArray()) {
        const at = raw.sql
          .exec<{ run_at: number | null }>(`SELECT MIN(run_at) AS run_at FROM ${name}`)
          .one().run_at;
        if (at !== null && (next === null || at < next)) next = at;
      }
      return next;
    });
    const at = next ?? alarm;
    const now = yield* Clock.currentTimeMillis;
    if (at !== null) yield* Effect.promise(() => raw.setAlarm(Math.max(at, now + 1)));
  });

// ---------------------------------------------------------------- the target's move

/** Where a target's move has got to, in its storage. */
export type MoveState =
  | { readonly phase: "copy"; readonly after: SnapshotCursor; readonly from: number }
  | { readonly phase: "catchup"; readonly through: number }
  | {
      readonly phase: "seal";
      readonly through: number;
      readonly sql: SqlCursor | null;
      readonly alarm?: number | null;
    }
  | { readonly phase: "owned" };

const STATE = `${MOVE_PREFIX}state`;

/** The source, as the target calls it. Each call is an RPC to the source object. */
export interface SourceCalls {
  readonly begin: () => Effect.Effect<number, unknown>;
  readonly snapshot: (after: SnapshotCursor) => Effect.Effect<SnapshotPage, unknown>;
  readonly changes: (after: number) => Effect.Effect<ChangesPage, unknown>;
  readonly seal: () => Effect.Effect<{ readonly alarm: number | null }, unknown>;
  readonly sql: (at: SqlCursor | null) => Effect.Effect<SqlPage, unknown>;
  readonly finish: () => Effect.Effect<void, unknown>;
}

/** Changes a catch-up pass may leave before the target seals: one page. */
const SEAL_WHEN_BELOW = KV_PAGE;

/** The target's move state, or `undefined` before it begins. */
export const moveState = (raw: cf.DurableObjectStorage) => raw.kv.get<MoveState>(STATE);

const setState = (raw: cf.DurableObjectStorage, state: MoveState) =>
  Effect.sync(() => raw.kv.put(STATE, state));

/**
 * Start the move: the source begins logging, then the copy starts after the
 * log's current end, so every write from here on is either in the copy or in
 * the log. Safe to repeat.
 */
export const begin = (raw: cf.DurableObjectStorage, source: SourceCalls) =>
  Effect.gen(function* () {
    if (moveState(raw) !== undefined) return;
    const from = yield* source.begin();
    yield* setState(raw, { phase: "copy", after: null, from });
  });

/**
 * Work on the move in the background for up to `budgetMillis`: copy, then
 * catch up. Answers `true` once the move is ready to seal. Each page is
 * recorded before the next, so a crash resumes where it stopped.
 */
export const copyFor = (raw: cf.DurableObjectStorage, source: SourceCalls, budgetMillis: number) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + budgetMillis;
    while ((yield* Clock.currentTimeMillis) < until) {
      const state = moveState(raw);
      if (state === undefined || state.phase === "owned" || state.phase === "seal") return true;
      if (state.phase === "copy") {
        const page = yield* source.snapshot(state.after);
        yield* putEntries(raw, page.entries);
        yield* setState(
          raw,
          page.next === null
            ? { phase: "catchup", through: state.from }
            : { phase: "copy", after: page.next, from: state.from },
        );
        continue;
      }
      const page = yield* source.changes(state.through);
      yield* applyChanges(raw, page);
      yield* setState(raw, { phase: "catchup", through: page.through });
      if (!page.more && page.entries.length < SEAL_WHEN_BELOW) return true;
    }
    return false;
  });

/**
 * Take over: seal the source, then read the last of its log and its SQL
 * tables, and own the data. Run with the target's own calls held, so none is
 * served between the source's last write and the target's first. Safe to
 * repeat: a seal answers the same, and pages are written over.
 */
export const takeOver = (raw: cf.DurableObjectStorage, source: SourceCalls) =>
  Effect.gen(function* () {
    let state = moveState(raw);
    if (state === undefined || state.phase === "owned") return;
    if (state.phase === "copy") return yield* Effect.die(new Error("take over before the copy"));
    if (state.phase === "catchup") {
      const { alarm } = yield* source.seal();
      state = { phase: "seal", through: state.through, sql: null, alarm };
      yield* setState(raw, state);
    }
    // Sealed: nothing changes on the source any more.
    for (let through = state.through; ;) {
      const page = yield* source.changes(through);
      yield* applyChanges(raw, page);
      through = page.through;
      yield* setState(raw, { ...state, through });
      if (!page.more) break;
    }
    for (let at = state.sql; ;) {
      const page = yield* source.sql(at);
      yield* putSql(raw, page);
      if (page.next === null) break;
      at = page.next;
      yield* setState(raw, { ...state, sql: at });
    }
    yield* rearm(raw, state.alarm ?? null);
    yield* setState(raw, { phase: "owned" });
    // The source is no longer needed: best effort, the next move or the class's deletion empties it.
    yield* source.finish().pipe(Effect.ignore);
  });
