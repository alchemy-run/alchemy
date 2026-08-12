/**
 * The concrete object store: DO SQLite rows + R2 overflow (DESIGN.md §3.3).
 *
 * Implements the git layer's `ObjectSource` contract over the `objects`
 * table, dispatching byte reads on the `location` column:
 *
 * - `'row'`  — the `zdata` BLOB (zlib(content), no loose header),
 * - `'r2'`   — a streamed R2 `get` of `r2_key` (which may point into a fork
 *   parent's prefix — immutable, shared),
 * - `'pack'` — v1.1 compaction; reads die with {@link NotImplementedError}
 *   until the compaction alarm lands (schema-ready, DESIGN.md §10).
 *
 * Plus the push-side surface the protocol layer needs: staged inserts with
 * the row/R2 placement policy, batched metadata reads, and the
 * staged-∪-live membership oracle behind the receive-pack connectivity
 * check (DESIGN.md §3.6 step 5).
 *
 * All reads on the `ObjectSource` surface see **live objects only**
 * (`staged_push IS NULL`); staged rows become visible to fetches only after
 * the final `transactionSync` flips them live.
 */
import type { R2Error, ReadWriteBucketClient } from "alchemy/Cloudflare/R2";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ObjectType, Oid } from "../git/ObjectCodec.ts";
import {
  StoreError,
  type ObjectLocation,
  type ObjectMeta,
  type ObjectSource,
} from "../git/Store.ts";
import * as Zlib from "../git/Zlib.ts";
import { objectKey, packKey } from "./Keys.ts";
import type { ObjectMetaRow, SqlClient } from "./Sql.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compressed-size threshold above which an object's bytes are offloaded to
 * R2 (`location = 'r2'`) instead of a row BLOB — 1 MiB, a safety margin
 * under the 2 MB SQLite row cap (DESIGN.md §3.3).
 */
export const R2_OFFLOAD_THRESHOLD = 1_048_576;

/**
 * Per-object uncompressed size cap for v1 — 64 MiB. Delta application needs
 * base + result in memory; this keeps worst-case ingest memory bounded.
 * Enforced by `PackParser` (rejected with `unpack object too large`);
 * exported here as the storage layer's authoritative constant.
 */
export const MAX_OBJECT_SIZE = 67_108_864;

/**
 * Raised (as a defect, via `Effect.die`) when a v1 code path reaches a
 * feature the design explicitly defers — currently only reads of
 * `location = 'pack'` objects, which exist starting with v1.1 compaction.
 */
export class NotImplementedError extends Schema.TaggedError<NotImplementedError>()(
  "NotImplementedError",
  { feature: Schema.String },
) {}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pack entry resolved by `PackParser`, ready to stage: the object id, its
 * numeric type, uncompressed size, and the zlib-compressed bytes to store
 * (the pack's compressed span verbatim for non-delta entries; a fresh
 * `deflate(content)` for delta-resolved ones).
 */
export interface StagedObject {
  readonly oid: Oid;
  readonly type: ObjectType;
  /** Uncompressed content size in bytes. */
  readonly size: number;
  /** `zlib(content)` without the loose header. */
  readonly zdata: Uint8Array;
}

/** Outcome of {@link ObjectStore.insertStaged}. */
export type InsertOutcome = "inserted" | "exists";

/**
 * The full storage surface of a repo's objects: the read-only
 * `ObjectSource` the protocol layer consumes, plus batched metadata reads,
 * staged inserts, and the connectivity-check membership oracle.
 */
export interface ObjectStore extends ObjectSource {
  /**
   * Batched metadata for many oids (live objects only). Chunked `IN`
   * queries, ≤ 100 params each. Missing oids are simply absent from the map.
   */
  readonly getMetaBatch: (
    oids: ReadonlyArray<Oid>,
  ) => Effect.Effect<ReadonlyMap<Oid, ObjectMeta>, StoreError>;
  /**
   * Stages one resolved object for `pushId` (DESIGN.md §3.6 step 4).
   *
   * Placement policy: compressed size > 1 MiB ⇒ the bytes are written to R2
   * **first** (`{repoId}/objects/{oid}`, content-addressed so re-runs are
   * idempotent), then the metadata row; otherwise the row carries the BLOB.
   *
   * Existing oids are skipped (idempotent re-push). A row left staged by a
   * **different** (crashed) push is adopted — re-stamped with this `pushId`
   * so the connectivity check and the final live-flip see it.
   */
  readonly insertStaged: (
    pushId: string,
    object: StagedObject,
  ) => Effect.Effect<InsertOutcome, StoreError>;
  /**
   * The connectivity-check membership oracle: returns the subset of `oids`
   * that exist in **neither** the live store **nor** this push's staged
   * rows. An empty result means every referenced object is present and the
   * push is safe to commit.
   */
  readonly missingObjects: (
    oids: ReadonlyArray<Oid>,
    pushId: string,
  ) => Effect.Effect<ReadonlyArray<Oid>, StoreError>;
}

/**
 * Dependencies of {@link makeObjectStore}. Plain values (not Layers) so
 * `RepoObject.ts` wires the store inside its inner per-instance effect.
 */
export interface ObjectStoreOptions {
  /** The repo DO's SQL client (see `makeSqlClient`). */
  readonly sql: SqlClient;
  /** The R2 bucket client bound on the host Worker. */
  readonly bucket: ReadWriteBucketClient;
  /** The repo's ULID — the R2 key prefix (DESIGN.md §3.2). */
  readonly repoId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const VALID_LOCATIONS: ReadonlySet<string> = new Set(["row", "r2", "pack"]);

const isObjectType = (type: number): type is ObjectType =>
  type === 1 || type === 2 || type === 3 || type === 4;

const metaFromRow = (
  row: ObjectMetaRow,
): Effect.Effect<ObjectMeta, StoreError> => {
  if (!isObjectType(row.type) || !VALID_LOCATIONS.has(row.location)) {
    return Effect.fail(
      new StoreError({
        reason: `corrupt objects row for ${row.oid}: type=${row.type} location=${row.location}`,
      }),
    );
  }
  return Effect.succeed({
    oid: row.oid,
    type: row.type,
    size: row.size,
    zsize: row.zsize,
    location: row.location as ObjectLocation,
  });
};

/**
 * Returns a plain `ArrayBuffer` view of the bytes for SQLite BLOB binding
 * (workerd binds `ArrayBuffer`, not typed arrays). Zero-copy when the view
 * spans its whole buffer.
 */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength &&
  bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer);

/** Row projection used by the byte-read dispatch. */
interface ZDataRow extends Record<
  string,
  string | number | ArrayBuffer | null
> {
  readonly oid: string;
  readonly location: string;
  readonly zdata: ArrayBuffer | null;
  readonly r2_key: string | null;
  /** sha1 of the containing pack when `location='pack'` (DESIGN §12.1). */
  readonly pack_id: string | null;
  /** Byte offset of this object's zdata span inside that pack. */
  readonly pack_offset: number | null;
  /** Length of the zdata span (mirrors `zsize`). */
  readonly zsize: number;
}

/**
 * Creates the {@link ObjectStore} for one repo. Plain factory — no Layers —
 * so `RepoObject.ts` can wire it in its inner effect with the ambient
 * `state`/bucket handles.
 */
export const makeObjectStore = (options: ObjectStoreOptions): ObjectStore => {
  const { sql, bucket, repoId } = options;

  /** Discharges the R2 client's `RuntimeContext` coloring and closes the
   * error union into `StoreError` (we run inside the Repo DO). */
  const runR2 = <A>(
    effect: Effect.Effect<A, R2Error, RuntimeContext>,
    what: string,
  ): Effect.Effect<A, StoreError> =>
    effect.pipe(
      Effect.mapError(
        (error) => new StoreError({ reason: `${what}: ${error.message}` }),
      ),
      Effect.provide(RuntimeContext.phantom),
    );

  const zlibToStore = (error: Zlib.ZlibError): StoreError =>
    new StoreError({ reason: error.reason });

  const readRow = (oid: Oid): Effect.Effect<ZDataRow | undefined, StoreError> =>
    sql.first<ZDataRow>(
      `SELECT oid, location, zdata, r2_key, pack_id, pack_offset, zsize
         FROM objects WHERE oid = ? AND staged_push IS NULL`,
      oid,
    );

  const requireRow = Effect.fn(function* (oid: Oid) {
    const row = yield* readRow(oid);
    if (row === undefined) {
      return yield* Effect.fail(
        new StoreError({ reason: `object not found: ${oid}` }),
      );
    }
    return row;
  });

  /** Fetches the R2 body for an `'r2'`-located row. */
  const r2Body = Effect.fn(function* (oid: Oid, r2Key: string | null) {
    if (r2Key === null) {
      return yield* Effect.fail(
        new StoreError({
          reason: `object ${oid} has location='r2' but no r2_key`,
        }),
      );
    }
    const body = yield* runR2(bucket.get(r2Key), `R2 get ${r2Key}`);
    if (body === null) {
      return yield* Effect.fail(
        new StoreError({ reason: `R2 object missing: ${r2Key}` }),
      );
    }
    return body;
  });

  /**
   * Reads an object's zdata span out of a compacted R2 pack (DESIGN §12.1).
   *
   * `pack_offset` addresses the object's **zdata** directly (not the pack
   * entry header), so one ranged GET returns exactly the stored compressed
   * bytes — the same bytes a `location='row'` object holds in its BLOB.
   * Entry headers are regenerated from `(type, size)` at emission time.
   */
  const packBytes = Effect.fn(function* (oid: Oid, row: ZDataRow) {
    if (row.pack_id === null || row.pack_offset === null) {
      return yield* Effect.fail(
        new StoreError({
          reason: `object ${oid} has location='pack' but no pack coordinates`,
        }),
      );
    }
    const key = packKey(repoId, row.pack_id);
    const body = yield* runR2(
      bucket.get(key, {
        range: { offset: row.pack_offset, length: row.zsize },
      }),
      `R2 ranged get ${key}`,
    );
    if (body === null) {
      return yield* Effect.fail(
        new StoreError({ reason: `pack missing: ${key}` }),
      );
    }
    return yield* body
      .bytes()
      .pipe(
        Effect.mapError(
          (error) =>
            new StoreError({ reason: `R2 read ${key}: ${error.message}` }),
        ),
      );
  });

  /** Reads the stored compressed bytes fully into memory. */
  const readZBytes = Effect.fn(function* (oid: Oid) {
    const row = yield* requireRow(oid);
    switch (row.location) {
      case "row": {
        if (row.zdata === null) {
          return yield* Effect.fail(
            new StoreError({
              reason: `object ${oid} has location='row' but NULL zdata`,
            }),
          );
        }
        return new Uint8Array(row.zdata);
      }
      case "r2": {
        const body = yield* r2Body(oid, row.r2_key);
        return yield* body.bytes().pipe(
          Effect.mapError(
            (error) =>
              new StoreError({
                reason: `R2 read ${row.r2_key}: ${error.message}`,
              }),
          ),
        );
      }
      case "pack":
        return yield* packBytes(oid, row);
      default:
        return yield* Effect.fail(
          new StoreError({
            reason: `object ${oid} has unknown location '${row.location}'`,
          }),
        );
    }
  });

  const getMetaBatch = (
    oids: ReadonlyArray<Oid>,
  ): Effect.Effect<ReadonlyMap<Oid, ObjectMeta>, StoreError> =>
    Effect.gen(function* () {
      const unique = Array.from(new Set(oids));
      const map = new Map<Oid, ObjectMeta>();
      if (unique.length === 0) {
        return map;
      }
      const rows = yield* sql.inChunks<ObjectMetaRow>(
        (ph) =>
          `SELECT oid, type, size, zsize, location FROM objects WHERE oid IN (${ph}) AND staged_push IS NULL`,
        unique,
      );
      for (const row of rows) {
        map.set(row.oid, yield* metaFromRow(row));
      }
      return map;
    });

  return {
    // ── ObjectSource (live objects only) ────────────────────────────────────
    has: (oid) =>
      sql
        .first<{ one: number }>(
          `SELECT 1 AS one FROM objects WHERE oid = ? AND staged_push IS NULL`,
          oid,
        )
        .pipe(Effect.map((row) => row !== undefined)),

    filterExisting: (oids) =>
      Effect.gen(function* () {
        const unique = Array.from(new Set(oids));
        if (unique.length === 0) {
          return [];
        }
        const rows = yield* sql.inChunks<{ oid: string }>(
          (ph) =>
            `SELECT oid FROM objects WHERE oid IN (${ph}) AND staged_push IS NULL`,
          unique,
        );
        return rows.map((row) => row.oid);
      }),

    getMeta: (oid) =>
      Effect.gen(function* () {
        const row = yield* sql.first<ObjectMetaRow>(
          `SELECT oid, type, size, zsize, location FROM objects WHERE oid = ? AND staged_push IS NULL`,
          oid,
        );
        if (row === undefined) {
          return undefined;
        }
        return yield* metaFromRow(row);
      }),

    readZData: (oid) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const row = yield* requireRow(oid);
          switch (row.location) {
            case "row": {
              if (row.zdata === null) {
                return yield* Effect.fail(
                  new StoreError({
                    reason: `object ${oid} has location='row' but NULL zdata`,
                  }),
                );
              }
              return Stream.succeed(new Uint8Array(row.zdata));
            }
            case "r2": {
              const body = yield* r2Body(oid, row.r2_key);
              return body.body.pipe(
                Stream.mapError(
                  (error) =>
                    new StoreError({
                      reason: `R2 stream ${row.r2_key}: ${error.message}`,
                    }),
                ),
              );
            }
            case "pack":
              return Stream.succeed(yield* packBytes(oid, row));
            default:
              return yield* Effect.fail(
                new StoreError({
                  reason: `object ${oid} has unknown location '${row.location}'`,
                }),
              );
          }
        }),
      ),

    readContent: (oid) =>
      readZBytes(oid).pipe(
        Effect.flatMap((zdata) =>
          Zlib.inflate(zdata).pipe(Effect.mapError(zlibToStore)),
        ),
      ),

    // ── Store-side surface ──────────────────────────────────────────────────
    getMetaBatch,

    insertStaged: Effect.fn(function* (pushId: string, object: StagedObject) {
      const existing = yield* sql.first<{ staged_push: string | null }>(
        `SELECT staged_push FROM objects WHERE oid = ?`,
        object.oid,
      );
      if (existing !== undefined) {
        if (existing.staged_push !== null && existing.staged_push !== pushId) {
          // Adopt a row left staged by a crashed push so this push's
          // connectivity check and live-flip see it.
          yield* sql.run(
            `UPDATE objects SET staged_push = ? WHERE oid = ? AND staged_push IS NOT NULL`,
            pushId,
            object.oid,
          );
        }
        return "exists" as const;
      }
      if (object.zdata.byteLength > R2_OFFLOAD_THRESHOLD) {
        // R2 write FIRST, then the metadata row — a crash between the two
        // leaves only a harmless content-addressed R2 orphan.
        const key = objectKey(repoId, object.oid);
        yield* runR2(bucket.put(key, object.zdata), `R2 put ${key}`);
        yield* sql.run(
          `INSERT OR IGNORE INTO objects (oid, type, size, zsize, location, zdata, r2_key, staged_push)
           VALUES (?, ?, ?, ?, 'r2', NULL, ?, ?)`,
          object.oid,
          object.type,
          object.size,
          object.zdata.byteLength,
          key,
          pushId,
        );
      } else {
        yield* sql.run(
          `INSERT OR IGNORE INTO objects (oid, type, size, zsize, location, zdata, staged_push)
           VALUES (?, ?, ?, ?, 'row', ?, ?)`,
          object.oid,
          object.type,
          object.size,
          object.zdata.byteLength,
          toArrayBuffer(object.zdata),
          pushId,
        );
      }
      return "inserted" as const;
    }),

    missingObjects: (oids, pushId) =>
      Effect.gen(function* () {
        const unique = Array.from(new Set(oids));
        if (unique.length === 0) {
          return [];
        }
        const rows = yield* sql.inChunks<{ oid: string }>(
          (ph) =>
            `SELECT oid FROM objects WHERE oid IN (${ph}) AND (staged_push IS NULL OR staged_push = ?)`,
          unique,
          { suffix: [pushId] },
        );
        const present = new Set(rows.map((row) => row.oid));
        return unique.filter((oid) => !present.has(oid));
      }),
  };
};
