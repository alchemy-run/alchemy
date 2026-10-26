import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { Json } from "./Platform.ts";

/**
 * A storage backend failed: a lost connection, a constraint, a timeout. The
 * platform treats it as a defect of the operation that hit it; durable work
 * (deliveries, scheduled commands, saga runs) is retried by its timer.
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The keys of a partition to list, in ascending key order.
 */
export interface ListOptions {
  /** Only keys that start with this. */
  readonly prefix: string;
  /** The first key to include; defaults to `prefix`. */
  readonly start?: string;
  /** At most this many entries. */
  readonly limit?: number;
}

/**
 * A durable timer that is due: the partition it belongs to, its name, and when
 * it fires (epoch milliseconds).
 */
export interface Timer {
  readonly partition: string;
  readonly name: string;
  readonly at: number;
}

/**
 * Reads of one partition.
 */
export interface Reader {
  /** The JSON value stored under `key`, or `undefined`. */
  readonly get: <A = Json>(key: string) => Effect.Effect<A | undefined, StorageError>;
  /** Entries whose keys start with `prefix`, in ascending key order (keys compare by code point). */
  readonly list: <A = Json>(
    options: ListOptions,
  ) => Effect.Effect<ReadonlyArray<readonly [key: string, value: A]>, StorageError>;
  /** When the named timer fires, or `undefined` when it isn't set. */
  readonly timer: (name: string) => Effect.Effect<number | undefined, StorageError>;
}

/**
 * Reads and writes of one partition, inside {@link Storage.transact}.
 */
export interface Transaction extends Reader {
  /** Store JSON values, replacing any under the same keys. */
  readonly put: (entries: Readonly<Record<string, Json>>) => Effect.Effect<void, StorageError>;
  readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void, StorageError>;
  /** Set the named timer to fire at `at` (epoch milliseconds), replacing its due time. */
  readonly setTimer: (name: string, at: number) => Effect.Effect<void, StorageError>;
  readonly deleteTimer: (name: string) => Effect.Effect<void, StorageError>;
}

/**
 * Where a {@link StoragePlatform} keeps a domain: an ordered key-value store,
 * split into partitions, with durable timers. Each aggregate instance, view
 * key, policy key, projection key, stream key and saga run is one partition.
 *
 * Implement it to host a domain on any database. A backend must guarantee:
 *
 * - `transact` is exclusive per partition: a second `transact` on the same
 *   partition, from this process or any other, waits until the first ends.
 * - `transact` is atomic: when its Effect fails, none of its writes (values
 *   and timers) are kept.
 * - `due` finds timers set by any process.
 * - Keys and partition names compare by code point (binary collation).
 *
 * `SqlStorage` implements it over any `SqlClient` (Postgres, MySQL, SQLite).
 */
export class Storage extends Context.Service<
  Storage,
  {
    /** Run `f` with exclusive, atomic access to one partition. */
    readonly transact: <A, E, R>(
      partition: string,
      f: (tx: Transaction) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StorageError, R>;
    /** Read one partition without waiting for its lock. */
    readonly read: <A, E, R>(
      partition: string,
      f: (reader: Reader) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StorageError, R>;
    /**
     * Up to `limit` timers due at or before `now`, earliest first, across the
     * partitions whose names start with one of `prefixes` (the entities the
     * calling process hosts).
     */
    readonly due: (
      now: number,
      limit: number,
      prefixes: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Timer>, StorageError>;
  }
>()("alchemy/Domain/Storage") {}
