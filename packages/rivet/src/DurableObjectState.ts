import { gateExclusive, gateStorage } from "alchemy/Workers/InputGate";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * The least of a RivetKit actor context the state needs: its raw SQLite
 * database, its scheduler, its key and `waitUntil`. Declared structurally so
 * this module never imports RivetKit at plan time.
 *
 * @internal
 */
export interface ActorContextLike {
  readonly key: ReadonlyArray<string>;
  readonly db: ActorDatabase;
  readonly schedule: {
    at(timestamp: number, action: string, ...args: unknown[]): Promise<string>;
    cancel(id: string): Promise<boolean>;
  };
  waitUntil(promise: Promise<unknown>): void;
}

/** An actor's raw SQLite database, or a transaction on it. @internal */
export interface ActorDatabase {
  execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...args: unknown[]
  ): Promise<Row[]>;
  /** Run `callback` in an isolated transaction: commit if it resolves, roll back if it throws. */
  transaction<T>(callback: (tx: ActorDatabase) => Promise<T>): Promise<T>;
}

/** `SqlCursor.one` found no row, or more than one. */
export class SqlRowCountMismatch extends Data.TaggedError("Rivet.SqlRowCountMismatch")<{
  readonly message: string;
  readonly rows: number;
}> {}

/** A cursor over the rows a SQL statement returned. */
export interface SqlCursor<T> {
  /** Every row. */
  toArray(): Effect.Effect<T[]>;
  /** The only row. */
  one(): Effect.Effect<T, SqlRowCountMismatch>;
}

/** Options for {@link DurableObjectStorage.list}. */
export interface ListOptions {
  /** Only keys that start with this prefix. */
  prefix?: string;
  /** Only keys at or after this key. */
  start?: string;
  /** Only keys before this key. */
  end?: string;
  /** Return keys in descending order. */
  reverse?: boolean;
  /** Return at most this many entries. */
  limit?: number;
}

/**
 * A Durable Object's own storage, backed by the actor's SQLite database on
 * the Rivet control plane: a key-value store, raw SQL, and one alarm.
 */
export interface DurableObjectStorage {
  get<T>(key: string): Effect.Effect<T | undefined>;
  put<T>(key: string, value: T): Effect.Effect<void>;
  /** Whether the key existed. */
  delete(key: string): Effect.Effect<boolean>;
  list<T>(options?: ListOptions): Effect.Effect<Map<string, T>>;
  /** Delete every key-value entry. SQL tables you created are kept. */
  deleteAll(): Effect.Effect<void>;
  readonly sql: {
    exec<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): Effect.Effect<SqlCursor<T>>;
  };
  /** Run the object's `alarm` handler at `scheduledTime` (ms since epoch). */
  setAlarm(scheduledTime: number | Date): Effect.Effect<void>;
  /** When the alarm fires, in ms since epoch, or `null`. */
  getAlarm(): Effect.Effect<number | null>;
  deleteAlarm(): Effect.Effect<void>;
  /**
   * Run `effect` as one transaction: its storage operations commit together
   * if it succeeds and roll back if it fails, and no other call touches
   * storage until it finishes. A call back into this instance from inside
   * waits for it to finish, so don't call out from a transaction.
   */
  transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

/** The instance a Durable Object's methods run against. */
export interface DurableObjectStateShape {
  /** The name the instance was addressed by (`getByName(name)`). */
  readonly id: { readonly name: string; toString(): string };
  readonly storage: DurableObjectStorage;
  /** Keep the instance awake until `effect` completes. */
  waitUntil<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R>;
}

/** The running Durable Object instance's state. */
export class DurableObjectState extends Context.Service<
  DurableObjectState,
  DurableObjectStateShape
>()("Rivet.DurableObjectState") {}

/** The action RivetKit calls when an object's alarm comes due. @internal */
export const ALARM_ACTION = "__alchemy_alarm";

const KV_TABLE = "_alchemy_kv";
const META_TABLE = "_alchemy_meta";
const ALARM_KEY = "alarm";

/** Create Alchemy's storage tables. Run from the actor's database migration. @internal */
export const migrateStorage = async (db: ActorContextLike["db"]) => {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${KV_TABLE} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
  );
};

// Values keep their structured-clone shape (Maps, Dates, typed arrays):
// v8-serialized, base64 in a TEXT column.
const encode = (value: unknown) =>
  Effect.promise(async () => {
    const v8 = await import("node:v8");
    return Buffer.from(v8.serialize(value)).toString("base64");
  });
const decode = <T>(text: string) =>
  Effect.promise(async () => {
    const v8 = await import("node:v8");
    return v8.deserialize(Buffer.from(text, "base64")) as T;
  });

/** The transaction storage runs in, inside `storage.transaction`. */
const CurrentTransaction = Context.Reference<ActorDatabase | undefined>(
  "Rivet/DurableObjectState/CurrentTransaction",
  { defaultValue: () => undefined },
);

const query = <Row extends Record<string, unknown>>(
  c: ActorContextLike,
  sql: string,
  ...args: unknown[]
) =>
  Effect.gen(function* () {
    const db = (yield* CurrentTransaction) ?? c.db;
    return yield* Effect.promise(() => db.execute<Row>(sql, ...args));
  });

/** Thrown inside a RivetKit transaction to roll it back. */
const rollback = Symbol("Rivet/DurableObjectState/rollback");

/** Build the state for one actor activation. @internal */
export const makeDurableObjectState = (c: ActorContextLike): DurableObjectStateShape => {
  const name = c.key[0] ?? "";

  const readAlarm = query<{ value: string }>(
    c,
    `SELECT value FROM ${META_TABLE} WHERE key = ?`,
    ALARM_KEY,
  ).pipe(
    Effect.map((rows) =>
      rows[0] === undefined ? undefined : (JSON.parse(rows[0].value) as { id: string; at: number }),
    ),
  );

  const ops: Omit<DurableObjectStorage, "transaction"> = {
    get: <T>(key: string) =>
      query<{ value: string }>(c, `SELECT value FROM ${KV_TABLE} WHERE key = ?`, key).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.undefined : decode<T>(rows[0].value),
        ),
      ),
    put: (key, value) =>
      Effect.flatMap(encode(value), (encoded) =>
        query(
          c,
          `INSERT INTO ${KV_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key,
          encoded,
        ),
      ).pipe(Effect.asVoid),
    delete: (key) =>
      query<{ key: string }>(c, `DELETE FROM ${KV_TABLE} WHERE key = ? RETURNING key`, key).pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    list: <T>(options: ListOptions = {}) =>
      Effect.gen(function* () {
        const clauses: string[] = [];
        const args: unknown[] = [];
        if (options.prefix !== undefined && options.prefix !== "") {
          clauses.push("substr(key, 1, ?) = ?");
          args.push(options.prefix.length, options.prefix);
        }
        if (options.start !== undefined) {
          clauses.push("key >= ?");
          args.push(options.start);
        }
        if (options.end !== undefined) {
          clauses.push("key < ?");
          args.push(options.end);
        }
        const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
        const order = options.reverse ? "DESC" : "ASC";
        const limit = options.limit !== undefined ? ` LIMIT ${Math.max(0, options.limit | 0)}` : "";
        const rows = yield* query<{ key: string; value: string }>(
          c,
          `SELECT key, value FROM ${KV_TABLE}${where} ORDER BY key ${order}${limit}`,
          ...args,
        );
        const entries = new Map<string, T>();
        for (const row of rows) {
          entries.set(row.key, yield* decode<T>(row.value));
        }
        return entries;
      }),
    deleteAll: () => query(c, `DELETE FROM ${KV_TABLE}`).pipe(Effect.asVoid),
    sql: {
      exec: <T extends Record<string, unknown>>(sql: string, ...bindings: unknown[]) =>
        query<T>(c, sql, ...bindings).pipe(
          Effect.map((rows): SqlCursor<T> => ({
            toArray: () => Effect.succeed(rows),
            one: () =>
              rows.length === 1
                ? Effect.succeed(rows[0]!)
                : Effect.fail(
                    new SqlRowCountMismatch({
                      message: `Expected exactly one row, got ${rows.length}`,
                      rows: rows.length,
                    }),
                  ),
          })),
        ),
    },
    setAlarm: (scheduledTime) =>
      Effect.gen(function* () {
        const at = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
        const existing = yield* readAlarm;
        if (existing !== undefined) {
          yield* Effect.promise(() => c.schedule.cancel(existing.id));
        }
        const id = yield* Effect.promise(() => c.schedule.at(at, ALARM_ACTION));
        yield* query(
          c,
          `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          ALARM_KEY,
          JSON.stringify({ id, at }),
        );
      }),
    getAlarm: () => readAlarm.pipe(Effect.map((alarm) => alarm?.at ?? null)),
    deleteAlarm: () =>
      Effect.gen(function* () {
        const existing = yield* readAlarm;
        if (existing === undefined) return;
        yield* Effect.promise(() => c.schedule.cancel(existing.id));
        yield* query(c, `DELETE FROM ${META_TABLE} WHERE key = ?`, ALARM_KEY);
      }),
  };

  // Calls run concurrently and every operation is a round trip, so each
  // one goes through the instance's input gate: a call's storage, with only
  // plain code between, can't interleave with another call's.
  const storage: DurableObjectStorage = {
    get: <T>(key: string) => gateStorage(ops.get<T>(key)),
    put: (key, value) => gateStorage(ops.put(key, value)),
    delete: (key) => gateStorage(ops.delete(key)),
    list: <T>(options?: ListOptions) => gateStorage(ops.list<T>(options)),
    deleteAll: () => gateStorage(ops.deleteAll()),
    sql: {
      exec: <T extends Record<string, unknown>>(sql: string, ...bindings: unknown[]) =>
        gateStorage(ops.sql.exec<T>(sql, ...bindings)),
    },
    setAlarm: (scheduledTime) => gateStorage(ops.setAlarm(scheduledTime)),
    getAlarm: () => gateStorage(ops.getAlarm()),
    deleteAlarm: () => gateStorage(ops.deleteAlarm()),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      gateExclusive(
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          const db = (yield* CurrentTransaction) ?? c.db;
          let exit: Exit.Exit<A, E> | undefined;
          yield* Effect.promise(() =>
            db
              .transaction(async (tx) => {
                exit = await Effect.runPromiseExitWith(context)(
                  effect.pipe(Effect.provideService(CurrentTransaction, tx)),
                );
                if (Exit.isFailure(exit)) throw rollback;
              })
              .catch((error: unknown) => {
                if (error !== rollback) throw error;
              }),
          );
          return yield* exit!;
        }),
      ),
  };

  return {
    id: { name, toString: () => name },
    storage,
    waitUntil: (effect) =>
      Effect.flatMap(Effect.context<never>(), (context) =>
        Effect.sync(() =>
          c.waitUntil(Effect.runPromise(effect.pipe(Effect.provideContext(context)) as never)),
        ),
      ),
  };
};

/**
 * Clear the stored alarm once it fires, so `getAlarm` reports `null` while
 * the handler runs (as on Cloudflare). @internal
 */
export const clearFiredAlarm = (c: ActorContextLike) =>
  query(c, `DELETE FROM ${META_TABLE} WHERE key = ?`, ALARM_KEY).pipe(Effect.asVoid);
