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

const PAGE = 500;
/** `storage.put` takes at most 128 entries at once. */
const PUT_BATCH = 128;

/** Tables and indexes Cloudflare and SQLite own. */
const userObjects = (sql: cf.SqlStorage) =>
  sql
    .exec<{ name: string; sql: string; type: string }>(
      "SELECT name, sql, type FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid",
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
          at.after === undefined ? { limit: PAGE } : { limit: PAGE, startAfter: at.after },
        ),
      );
      const entries = [...listed.entries()].filter(([key]) => !key.startsWith(TRANSFER_KEY_PREFIX));
      const last = [...listed.keys()].at(-1);
      return {
        entries,
        next:
          listed.size === PAGE && last !== undefined
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
      storage.sql.exec(`SELECT * FROM ${quote(name)} LIMIT ? OFFSET ?`, PAGE, at.offset),
    );
    const values: Array<Array<unknown>> = yield* Effect.sync(() => Array.from(result.raw()));
    return {
      schema,
      rows: { table: name, columns: result.columnNames, values },
      next:
        values.length === PAGE
          ? ({ phase: "sql", table: at.table, offset: at.offset + PAGE } as const)
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
