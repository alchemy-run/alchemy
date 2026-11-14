import { EventLifetime } from "alchemy/Workers/EventLifetime";
import { gateExclusive, gateStorage } from "alchemy/Workers/InputGate";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { notAwaited, openSection, within, type Activation } from "./internal/Calls.ts";
import type { SocketRegistry } from "./internal/Sockets.ts";
import type { WebSocket } from "./WebSocket.ts";

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
  /** Keep the actor awake until `promise` settles. */
  keepAwake<T>(promise: Promise<T>): Promise<T>;
}

/** An actor's raw SQLite database, or a transaction on it. @internal */
export interface ActorDatabase {
  execute<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...args: unknown[]
  ): Promise<Row[]>;
  /**
   * Run `callback` in an isolated transaction: commit if it resolves, roll
   * back if it throws. RivetKit rolls it back after `timeout` ms.
   */
  transaction<T>(
    callback: (tx: ActorDatabase) => Promise<T>,
    options?: { readonly timeout?: number },
  ): Promise<T>;
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

/** A transaction ran past its timeout: it was interrupted and rolled back. */
export class TransactionTimedOut extends Data.TaggedError("Rivet.TransactionTimedOut")<{
  readonly message: string;
}> {}

/** Options for {@link DurableObjectStorage.transaction}. */
export interface TransactionOptions {
  /**
   * How long the transaction may run before it's interrupted, rolled back,
   * and dies with {@link TransactionTimedOut}.
   * @default "30 seconds"
   */
  timeout?: Duration.Input;
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
   * storage until it finishes. It runs for at most `options.timeout`. A call
   * back into this instance from inside that needs storage fails with HTTP
   * 508 instead of waiting for it.
   */
  transaction<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: TransactionOptions,
  ): Effect.Effect<A, E, R>;
}

/** The instance a Durable Object's methods run against. */
export interface DurableObjectStateShape {
  /** The name the instance was addressed by (`getByName(name)`). */
  readonly id: { readonly name: string; toString(): string };
  readonly storage: DurableObjectStorage;
  /** Keep the instance awake until `effect` completes. */
  waitUntil<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R>;
  /**
   * The open WebSockets this instance accepted with `Rivet.upgrade()`; with
   * `tag`, only those accepted with it.
   */
  getWebSockets(tag?: string): Effect.Effect<ReadonlyArray<WebSocket>>;
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

/**
 * The alarm that's set: its RivetKit schedule (absent until a transaction
 * that set it commits), when, the token it fires with, and how many times
 * its handler has failed and been retried.
 */
interface StoredAlarm {
  readonly id?: string;
  readonly at: number;
  readonly token: string;
  readonly retries?: number;
}

/** A failed alarm is retried this many times, as on Cloudflare. */
const ALARM_RETRIES = 6;
/** The first retry's delay; each one after doubles it. */
const ALARM_RETRY_DELAY = 2_000;

const TRANSACTION_TIMEOUT: Duration.Input = "30 seconds";
/** RivetKit's own transaction timeout trails ours, so ours ends it first. */
const TRANSACTION_TIMEOUT_MARGIN = 5_000;

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

/**
 * The transaction storage runs in, inside `storage.transaction`, and the
 * scheduler work to run once it commits: RivetKit's scheduler writes through
 * the outer database, which the transaction holds until then.
 */
interface Transaction {
  readonly db: ActorDatabase;
  readonly afterCommit: Array<Effect.Effect<void>>;
  readonly parent: Transaction | undefined;
  /** Cleared once the transaction's code finishes. */
  open: boolean;
}

const CurrentTransaction = Context.Reference<Transaction | undefined>(
  "Rivet/DurableObjectState/CurrentTransaction",
  { defaultValue: () => undefined },
);

/**
 * The innermost transaction still open. Work a transaction started that
 * outlives it (handed to `waitUntil`, or forked) runs in the one around it,
 * or outside any once all have finished.
 */
const currentTransaction = Effect.map(CurrentTransaction, (transaction) => {
  let open = transaction;
  while (open !== undefined && !open.open) open = open.parent;
  return open;
});

const query = <Row extends Record<string, unknown>>(
  c: ActorContextLike,
  sql: string,
  ...args: unknown[]
) =>
  Effect.gen(function* () {
    const db = (yield* currentTransaction)?.db ?? c.db;
    return yield* Effect.promise(() => db.execute<Row>(sql, ...args));
  });

/** Thrown inside a RivetKit transaction to roll it back. */
const rollback = Symbol("Rivet/DurableObjectState/rollback");

interface OpenedTransaction {
  readonly tx: ActorDatabase;
  /** Commit or roll back, and wait for it. */
  readonly end: (commit: boolean) => Promise<void>;
}

/**
 * Begin a RivetKit transaction and hand it back, open, so its work runs on
 * the calling fiber (interruptible, with the caller's context) rather than
 * inside RivetKit's callback.
 */
const beginTransaction = (db: ActorDatabase, timeout: number) =>
  Effect.callback<OpenedTransaction>((resume) => {
    let interrupted = false;
    const done: Promise<void> = db
      .transaction(
        (tx) =>
          new Promise<void>((resolve, reject) => {
            const end = (commit: boolean) => {
              if (commit) resolve();
              else reject(rollback);
              return done;
            };
            // Interrupted before it began: nothing will end it.
            if (interrupted) void end(false);
            else resume(Effect.succeed({ tx, end }));
          }),
        { timeout },
      )
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    // It failed to begin (or to commit, once it has been handed back).
    done.catch((error: unknown) => resume(Effect.die(error)));
    return Effect.sync(() => {
      interrupted = true;
    });
  });

const readAlarm = (c: ActorContextLike) =>
  query<{ value: string }>(c, `SELECT value FROM ${META_TABLE} WHERE key = ?`, ALARM_KEY).pipe(
    Effect.map((rows) =>
      rows[0] === undefined ? undefined : (JSON.parse(rows[0].value) as StoredAlarm),
    ),
  );

const writeAlarm = (c: ActorContextLike, alarm: StoredAlarm) =>
  query(
    c,
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ALARM_KEY,
    JSON.stringify(alarm),
  );

// A schedule that has already fired, or a stale one, carries a token that
// no longer matches, so one left uncancelled is harmless.
const cancelSchedule = (c: ActorContextLike, alarm: StoredAlarm | undefined) =>
  alarm?.id === undefined
    ? Effect.void
    : Effect.asVoid(Effect.promise(() => c.schedule.cancel(alarm.id!)));

/** Set the alarm for `at`, replacing any that's set. */
const setAlarm = (c: ActorContextLike, at: number, retries?: number) =>
  Effect.gen(function* () {
    const existing = yield* readAlarm(c);
    // The token tells the firing alarm whether it's still the one set.
    const token = yield* SecureRandom.SecureRandom.pipe(
      Effect.flatMap((random) => random.uuidV4()),
      Effect.provide(SecureRandom.layerWebCrypto),
    );
    const schedule = Effect.gen(function* () {
      yield* cancelSchedule(c, existing);
      return yield* Effect.promise(() => c.schedule.at(at, ALARM_ACTION, token));
    });
    const transaction = yield* currentTransaction;
    if (transaction === undefined) {
      yield* writeAlarm(c, { id: yield* schedule, at, token, retries });
      return;
    }
    // Record it with the transaction; schedule it once that commits.
    const pending: StoredAlarm = { at, token, retries };
    yield* writeAlarm(c, pending);
    transaction.afterCommit.push(
      Effect.gen(function* () {
        const id = yield* schedule;
        yield* query(
          c,
          `UPDATE ${META_TABLE} SET value = ? WHERE key = ? AND value = ?`,
          JSON.stringify({ ...pending, id } satisfies StoredAlarm),
          ALARM_KEY,
          JSON.stringify(pending),
        );
      }),
    );
  });

/** Build the state for one actor activation. @internal */
export const makeDurableObjectState = (
  c: ActorContextLike,
  activation: Activation,
  sockets: SocketRegistry,
): DurableObjectStateShape => {
  const name = c.key[0] ?? "";

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
      setAlarm(c, typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime()),
    getAlarm: () => readAlarm(c).pipe(Effect.map((alarm) => alarm?.at ?? null)),
    deleteAlarm: () =>
      Effect.gen(function* () {
        const existing = yield* readAlarm(c);
        if (existing === undefined) return;
        yield* query(c, `DELETE FROM ${META_TABLE} WHERE key = ?`, ALARM_KEY);
        const transaction = yield* currentTransaction;
        if (transaction === undefined) yield* cancelSchedule(c, existing);
        else transaction.afterCommit.push(cancelSchedule(c, existing));
      }),
  };

  // Calls run concurrently and every operation is a round trip. A class
  // given `Workers.InputGate` runs each one through the instance's gate, so a
  // call's storage, with only plain code between, can't interleave with
  // another call's; without it, `gateStorage` runs them as they come. A call
  // a transaction here waits on would wait on the transaction forever: it
  // fails.
  const gated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.andThen(notAwaited(activation), gateStorage(effect));
  const storage: DurableObjectStorage = {
    get: <T>(key: string) => gated(ops.get<T>(key)),
    put: (key, value) => gated(ops.put(key, value)),
    delete: (key) => gated(ops.delete(key)),
    list: <T>(options?: ListOptions) => gated(ops.list<T>(options)),
    deleteAll: () => gated(ops.deleteAll()),
    sql: {
      exec: <T extends Record<string, unknown>>(sql: string, ...bindings: unknown[]) =>
        gated(ops.sql.exec<T>(sql, ...bindings)),
    },
    setAlarm: (scheduledTime) => gated(ops.setAlarm(scheduledTime)),
    getAlarm: () => gated(ops.getAlarm()),
    deleteAlarm: () => gated(ops.deleteAlarm()),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>, options?: TransactionOptions) =>
      Effect.andThen(
        notAwaited(activation),
        gateExclusive(
          Effect.gen(function* () {
            const timeout = Duration.fromInputUnsafe(options?.timeout ?? TRANSACTION_TIMEOUT);
            const parent = yield* currentTransaction;
            const afterCommit: Array<Effect.Effect<void>> = [];
            // Calls made from inside carry the section's token, so one that
            // comes back here fails instead of waiting on the transaction.
            const section = openSection(activation);
            const result = yield* Effect.acquireUseRelease(
              beginTransaction(
                parent?.db ?? c.db,
                Duration.toMillis(timeout) + TRANSACTION_TIMEOUT_MARGIN,
              ),
              ({ tx }) => {
                const transaction: Transaction = { db: tx, afterCommit, parent, open: true };
                return effect.pipe(
                  Effect.provideService(CurrentTransaction, transaction),
                  within(section),
                  Effect.timeoutOrElse({
                    duration: timeout,
                    orElse: () =>
                      Effect.die(
                        new TransactionTimedOut({
                          message: `The transaction ran past its ${Duration.format(timeout)} timeout and was rolled back.`,
                        }),
                      ),
                  }),
                  Effect.ensuring(
                    Effect.sync(() => {
                      transaction.open = false;
                      activation.open.delete(section.token);
                    }),
                  ),
                );
              },
              ({ end }, exit) => Effect.promise(() => end(Exit.isSuccess(exit))),
            );
            // A nested transaction's scheduler work waits for the outermost.
            if (parent !== undefined) parent.afterCommit.push(...afterCommit);
            else yield* Effect.forEach(afterCommit, (work) => work, { discard: true });
            return result;
          }),
        ),
      ),
  };

  return {
    id: { name, toString: () => name },
    storage,
    getWebSockets: (tag) => Effect.sync(() => sockets.all(tag)),
    // As on Cloudflare: the work runs with the caller's context and a scope
    // of its own, and the call's scope stays open until it settles.
    waitUntil: (effect) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const lifetime = yield* Effect.serviceOption(EventLifetime);
        yield* Effect.sync(() => {
          const promise = Effect.runPromiseWith(context)(effect.pipe(Effect.scoped) as never);
          if (Option.isSome(lifetime)) lifetime.value.extend(promise);
          c.waitUntil(promise);
        });
      }),
  };
};

/**
 * Claim a fired alarm: clear it, so `getAlarm` reports `null` while the
 * handler runs (as on Cloudflare), and return it if it's still the alarm
 * that's set. One replaced or deleted after RivetKit started firing it
 * leaves the newer alarm alone and doesn't run the handler. Goes through
 * the input gate, so it can't land inside a call's `setAlarm`.
 */
const claimFiredAlarm = (c: ActorContextLike, token: unknown) =>
  gateStorage(
    Effect.gen(function* () {
      const rows = yield* query<{ value: string }>(
        c,
        `SELECT value FROM ${META_TABLE} WHERE key = ?`,
        ALARM_KEY,
      );
      const stored = rows[0];
      if (stored === undefined) return undefined;
      const alarm = JSON.parse(stored.value) as StoredAlarm;
      if (alarm.token !== token) return undefined;
      yield* query(
        c,
        `DELETE FROM ${META_TABLE} WHERE key = ? AND value = ?`,
        ALARM_KEY,
        stored.value,
      );
      return alarm;
    }),
  );

/**
 * Run the handler of the alarm that fired with `token`, if it's still the
 * one set. A handler that fails is retried, as on Cloudflare: up to six
 * times, two seconds after the first failure and twice as long after each
 * one since, unless it set a new alarm itself. @internal
 */
export const runFiredAlarm = (
  c: ActorContextLike,
  token: unknown,
  handler: Effect.Effect<void, unknown> | undefined,
) =>
  Effect.gen(function* () {
    const fired = yield* claimFiredAlarm(c, token);
    if (fired === undefined || handler === undefined) return;
    const exit = yield* Effect.exit(handler);
    if (Exit.isSuccess(exit)) return;
    const retries = fired.retries ?? 0;
    yield* Effect.logError(
      retries < ALARM_RETRIES
        ? `Durable Object alarm failed; retry ${retries + 1} of ${ALARM_RETRIES}`
        : `Durable Object alarm failed ${ALARM_RETRIES + 1} times; giving up`,
      exit.cause,
    );
    if (retries >= ALARM_RETRIES) return;
    yield* gateStorage(
      Effect.gen(function* () {
        if ((yield* readAlarm(c)) !== undefined) return;
        const now = yield* Clock.currentTimeMillis;
        yield* setAlarm(c, now + ALARM_RETRY_DELAY * 2 ** retries, retries + 1);
      }),
    );
  });
