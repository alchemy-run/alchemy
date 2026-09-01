/**
 * In-process harness for the repo object store: a `SqlClient` over
 * `bun:sqlite` (the same DDL the Durable Object runs) and an in-memory
 * `BlobStoreShape` with ranged reads. Lets the emitter, compaction, and
 * closure code be unit-tested without a Worker.
 */
import { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { BlobBody, BlobMeta, BlobStoreShape } from "@/Git/BlobStore.ts";
import { BlobStoreError } from "@/Git/BlobStore.ts";
import {
  chunk,
  MAX_IN_PARAMS,
  placeholders,
  REPO_DDL,
  type SqlClient,
} from "@/Git/store/Sql.ts";
import { StoreError } from "@/Git/git/Store.ts";

type Value = string | number | ArrayBuffer | Uint8Array | null;

const bind = (v: Value): string | number | Uint8Array | null =>
  v instanceof ArrayBuffer ? new Uint8Array(v) : v;

/** Rows come back with BLOB columns as ArrayBuffer, like the DO. */
const normalize = (row: Record<string, unknown>) => {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (v instanceof Uint8Array) {
      row[key] = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    }
  }
  return row;
};

class RollbackSignal {
  constructor(readonly error: unknown) {}
}

export const makeTestSqlClient = (): SqlClient & { readonly db: Database } => {
  const db = new Database(":memory:");
  for (const ddl of REPO_DDL) db.run(ddl);

  const exec = (query: string, bindings: ReadonlyArray<Value>) => {
    const stmt = db.query(query);
    const rows = stmt.all(...bindings.map(bind)) as Array<
      Record<string, unknown>
    >;
    const out = rows.map(normalize);
    return {
      toArray: () => out,
      one: () => {
        if (out.length !== 1)
          throw new Error(`expected 1 row, got ${out.length}`);
        return out[0];
      },
      raw: () => out.map((r) => Object.values(r)),
      rowsWritten: 0,
      rowsRead: out.length,
      columnNames: out.length > 0 ? Object.keys(out[0]!) : [],
      [Symbol.iterator]: () => out[Symbol.iterator](),
    };
  };
  const raw = {
    exec: (query: string, ...bindings: Array<Value>) => exec(query, bindings),
  } as unknown as SqlClient["raw"];

  const allWith = <Row extends Record<string, unknown>>(
    query: string,
    bindings: ReadonlyArray<Value>,
  ) =>
    Effect.try({
      try: () => exec(query, bindings).toArray() as Array<Row>,
      catch: (cause) =>
        new StoreError({
          reason: `sql failed (${query.slice(0, 120)}): ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

  return {
    db,
    raw,
    all: (query, ...bindings) => allWith(query, bindings as Array<Value>),
    first: (query, ...bindings) =>
      allWith(query, bindings as Array<Value>).pipe(
        Effect.map((rows) => (rows.length > 0 ? rows[0] : undefined)),
      ) as never,
    run: (query, ...bindings) =>
      allWith(query, bindings as Array<Value>).pipe(Effect.asVoid),
    inChunks: (makeQuery, items, options) =>
      Effect.gen(function* () {
        const prefix = options?.prefix ?? [];
        const suffix = options?.suffix ?? [];
        const size = Math.max(
          1,
          Math.min(
            options?.chunkSize ?? MAX_IN_PARAMS,
            MAX_IN_PARAMS - prefix.length - suffix.length,
          ),
        );
        const rows: Array<never> = [];
        for (const part of chunk(items, size)) {
          const batch = yield* allWith(makeQuery(placeholders(part.length)), [
            ...prefix,
            ...part,
            ...suffix,
          ] as Array<Value>);
          for (const row of batch) rows.push(row as never);
        }
        return rows;
      }) as never,
    transactionSync: (body) =>
      Effect.try({
        try: () => {
          db.run("BEGIN");
          try {
            const result = body(raw, (error) => {
              throw new RollbackSignal(error);
            });
            db.run("COMMIT");
            return result;
          } catch (error) {
            db.run("ROLLBACK");
            throw error;
          }
        },
        catch: (cause) =>
          cause instanceof RollbackSignal
            ? (cause.error as never)
            : new StoreError({
                reason: `transactionSync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
      }) as never,
  };
};

export interface MemoryBlobStore extends BlobStoreShape {
  readonly objects: Map<string, Uint8Array>;
  /** Every `get`, with its range — for asserting window fetch counts. */
  readonly gets: Array<{ key: string; offset?: number; length?: number }>;
}

export const makeMemoryBlobStore = (): MemoryBlobStore => {
  const objects = new Map<string, Uint8Array>();
  const gets: MemoryBlobStore["gets"] = [];
  const body = (bytes: Uint8Array): BlobBody => ({
    size: bytes.length,
    bytes: Effect.succeed(bytes),
    stream: Stream.succeed(bytes),
  });
  return {
    objects,
    gets,
    get: (key, range) =>
      Effect.sync(() => {
        gets.push({ key, offset: range?.offset, length: range?.length });
        const whole = objects.get(key);
        if (whole === undefined) return null;
        if (range === undefined) return body(whole);
        return body(
          whole.subarray(
            range.offset,
            Math.min(range.offset + range.length, whole.length),
          ),
        );
      }),
    put: (key, data) =>
      Effect.gen(function* () {
        if (data instanceof Uint8Array) {
          objects.set(key, Uint8Array.from(data));
          return;
        }
        const parts = Array.from(
          yield* Stream.runCollect(
            data as Stream.Stream<Uint8Array, BlobStoreError>,
          ),
        );
        const total = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.length;
        }
        objects.set(key, out);
      }) as never,
    head: (key) =>
      Effect.sync((): BlobMeta | null => {
        const o = objects.get(key);
        return o === undefined ? null : { key, size: o.length };
      }),
    multipart: () =>
      Effect.fail(
        new BlobStoreError({ reason: "multipart unsupported in harness" }),
      ) as never,
    delete: (key) =>
      Effect.sync(() => {
        objects.delete(key);
      }),
    list: (prefix) =>
      Stream.fromIterable(
        Array.from(objects.entries())
          .filter(([k]) => k.startsWith(prefix ?? ""))
          .map(([key, o]): BlobMeta => ({ key, size: o.length })),
      ),
  } as MemoryBlobStore;
};
