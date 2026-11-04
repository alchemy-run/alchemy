import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

/**
 * Copy a SQLite-backed Durable Object's whole storage to another object, one
 * page per call: its key-value entries, its SQL tables (schema and rows) and
 * its alarm. The source pages it out with {@link exportPage}; the target
 * writes each page with {@link importPage}, then sets the alarm.
 *
 * The source must not change while it is copied: pages are read by offset.
 */

/** Where the next page starts. */
export type TransferCursor =
  | { readonly phase: "kv"; readonly after?: string }
  | { readonly phase: "sql"; readonly table: number; readonly offset: number };

export interface TransferPage {
  /** The user tables and indexes, as `CREATE` statements: on the first SQL page. */
  readonly schema?: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  readonly entries?: ReadonlyArray<readonly [string, unknown]>;
  readonly rows?: {
    readonly table: string;
    readonly columns: ReadonlyArray<string>;
    readonly values: ReadonlyArray<ReadonlyArray<unknown>>;
  };
  /** The next page, or `null` on the last one, which also carries the alarm. */
  readonly next: TransferCursor | null;
  readonly alarm?: number | null;
}

/**
 * An instance member that tells the bridge not to run the object's stored
 * alarm callbacks: the instance's `alarm` handles the alarm instead. An object
 * whose data is moving elsewhere sets it, so callbacks registered by code it
 * no longer runs aren't claimed (and counted as attempts) before they move.
 */
export const OwnsAlarmCallbacks = "~alchemy/ownsAlarmCallbacks";

/** Keys the transfer itself uses: never copied. */
export const TRANSFER_KEY_PREFIX = "~transfer:";

/** Key-value entries per page: at most 128 KiB each, so a page stays well under RPC's 32 MiB. */
const KV_PAGE = 128;
/** Rows per page, cut short once they pass {@link PAGE_BYTES}. */
const SQL_PAGE = 200;
const PAGE_BYTES = 8 * 1024 * 1024;

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
/** `storage.put` takes at most 128 entries at once. */
const PUT_BATCH = 128;

/** Tables and indexes Cloudflare and SQLite own. */
const userObjects = (sql: cf.SqlStorage) =>
  sql
    .exec<{ name: string; sql: string; type: string }>(
      "SELECT name, sql, type FROM sqlite_master WHERE sql IS NOT NULL AND substr(name, 1, 4) != '_cf_' AND substr(name, 1, 7) != 'sqlite_' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid",
    )
    .toArray();

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export const exportPage = (
  storage: cf.DurableObjectStorage,
  from: TransferCursor | null,
): Effect.Effect<TransferPage> =>
  Effect.gen(function* () {
    const at: TransferCursor = from ?? { phase: "kv" };
    if (at.phase === "kv") {
      const listed = yield* Effect.promise(() =>
        storage.list(
          at.after === undefined ? { limit: KV_PAGE } : { limit: KV_PAGE, startAfter: at.after },
        ),
      );
      const entries = [...listed.entries()].filter(([key]) => !key.startsWith(TRANSFER_KEY_PREFIX));
      const last = [...listed.keys()].at(-1);
      return {
        entries,
        next:
          listed.size === KV_PAGE && last !== undefined
            ? ({ phase: "kv", after: last } as const)
            : ({ phase: "sql", table: 0, offset: 0 } as const),
      } satisfies TransferPage;
    }
    const objects = yield* Effect.sync(() => userObjects(storage.sql));
    const tables = objects.filter((object) => object.type === "table");
    const schema =
      at.table === 0 && at.offset === 0
        ? objects.map(({ name, sql }) => ({ name, sql }))
        : undefined;
    const table: { readonly name: string } | undefined = tables[at.table];
    if (table === undefined) {
      const alarm = yield* Effect.promise(() => storage.getAlarm());
      return { schema, next: null, alarm } satisfies TransferPage;
    }
    const name = table.name;
    const result: cf.SqlStorageCursor<Record<string, cf.SqlStorageValue>> = yield* Effect.sync(() =>
      storage.sql.exec(`SELECT * FROM ${quote(name)} LIMIT ? OFFSET ?`, SQL_PAGE, at.offset),
    );
    const rows: Array<Array<unknown>> = yield* Effect.sync(() => Array.from(result.raw()));
    // Cut the page short once it is large: large rows move a few at a time.
    const values: Array<Array<unknown>> = [];
    let bytes = 0;
    for (const row of rows) {
      if (values.length > 0 && bytes + sizeOf(row) > PAGE_BYTES) break;
      values.push(row);
      bytes += sizeOf(row);
    }
    return {
      schema,
      rows: { table: name, columns: result.columnNames, values },
      next:
        values.length < rows.length || rows.length === SQL_PAGE
          ? ({ phase: "sql", table: at.table, offset: at.offset + values.length } as const)
          : ({ phase: "sql", table: at.table + 1, offset: 0 } as const),
    } satisfies TransferPage;
  });

/**
 * Write a page into the target. Safe to repeat: a table that exists is kept,
 * and rows and entries are written over.
 */
export const importPage = (storage: cf.DurableObjectStorage, page: TransferPage) =>
  Effect.gen(function* () {
    if (page.schema !== undefined) {
      const schema = page.schema;
      yield* Effect.sync(() => {
        const existing = new Set(userObjects(storage.sql).map((object) => object.name));
        for (const { name, sql } of schema) if (!existing.has(name)) storage.sql.exec(sql);
      });
    }
    if (page.rows !== undefined && page.rows.values.length > 0) {
      const { table, columns, values } = page.rows;
      yield* Effect.sync(() => {
        const insert = `INSERT OR REPLACE INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
        storage.transactionSync(() => {
          for (const row of values) storage.sql.exec(insert, ...row);
        });
      });
    }
    const entries = page.entries ?? [];
    for (let i = 0; i < entries.length; i += PUT_BATCH) {
      const batch = Object.fromEntries(entries.slice(i, i + PUT_BATCH));
      yield* Effect.promise(() => storage.put(batch));
    }
  });
