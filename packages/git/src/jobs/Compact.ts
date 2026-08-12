/**
 * The compaction alarm job (DESIGN.md §12.1) — the v2 storage plane.
 *
 * v1 keeps every object's bytes in a DO SQLite row, which caps a repo at the
 * 10 GB DO limit and puts all clone bandwidth behind one single-threaded
 * object. Compaction moves those bytes into **immutable, content-addressed
 * R2 packs** and leaves only the index behind:
 *
 * ```
 * objects.location: 'row'  →  'pack'
 * objects.zdata:    BLOB   →  NULL     (bytes now live in R2)
 * objects.pack_id / pack_offset:       (where in R2 they live)
 * ```
 *
 * The pack we write is a **real git packfile** (`PACK`, version 2, count,
 * then `varint(type,size) + zdata` per entry, then the SHA-1 trailer), so it
 * can later be served verbatim as a clone bundle or a `packfile-uris`
 * target. That works only because objects are stored **pre-deflated**: a
 * pack entry is the stored bytes with a small header in front, so compaction
 * is a copy, never a recompression.
 *
 * `pack_offset` deliberately addresses each object's **zdata span**, not its
 * entry header — a read is then one ranged R2 GET returning exactly the
 * bytes a `location='row'` object would have held (see `ObjectStore`).
 *
 * Bounded per run and alarm-re-armable, like the purge job: at most
 * {@link MAX_OBJECTS_PER_RUN} objects / {@link MAX_BYTES_PER_RUN} bytes are
 * moved per alarm, and the job reports whether more remain.
 */
import type { R2Error, ReadWriteBucketClient } from "alchemy/Cloudflare/R2";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import {
  bytesToHex,
  encodeTypeSize,
  makeSha1,
  type PackEntryType,
} from "../git/ObjectCodec.ts";
import { StoreError } from "../git/Store.ts";
import { packKey } from "../store/Keys.ts";
import type { SqlClient } from "../store/Sql.ts";

/** Objects moved per alarm run. */
export const MAX_OBJECTS_PER_RUN = 2_000;

/**
 * Byte budget per alarm run (assembled in memory before the R2 put). Well
 * under the 128 MB isolate limit; the streaming-multipart upgrade lifts it.
 */
export const MAX_BYTES_PER_RUN = 32 * 1024 * 1024;

/**
 * Loose-bytes threshold that arms compaction (DESIGN.md §12.1).
 */
export const COMPACT_BYTES_THRESHOLD = 1024 * 1024 * 1024;

/** Loose-object-count threshold that arms compaction. */
export const COMPACT_COUNT_THRESHOLD = 50_000;

/** Outcome of one compaction run. */
export interface CompactOutcome {
  /** Objects moved into the pack this run. */
  readonly moved: number;
  /** Bytes of zdata moved. */
  readonly bytes: number;
  /** sha1 of the pack written (the rows' `pack_id`), else `undefined`. */
  readonly packId: string | undefined;
  /** True when loose objects remain — the caller re-arms the alarm. */
  readonly more: boolean;
}

/** Dependencies of {@link runCompactJob}. */
export interface CompactJobOptions {
  readonly repoId: string;
  readonly sql: SqlClient;
  readonly bucket: ReadWriteBucketClient;
  readonly maxObjects?: number | undefined;
  readonly maxBytes?: number | undefined;
}

interface LooseRow extends Record<
  string,
  string | number | ArrayBuffer | null
> {
  readonly oid: string;
  readonly type: number;
  readonly size: number;
  readonly zsize: number;
  readonly zdata: ArrayBuffer | null;
}

const runR2 =
  (what: string) =>
  <A>(
    effect: Effect.Effect<A, R2Error, RuntimeContext>,
  ): Effect.Effect<A, StoreError> =>
    effect.pipe(
      Effect.mapError(
        (error) => new StoreError({ reason: `${what}: ${error.message}` }),
      ),
      Effect.provide(RuntimeContext.phantom),
    );

const PACK_SIGNATURE = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"

/** `PACK` + version 2 + object count. */
const packHeader = (count: number): Uint8Array => {
  const header = new Uint8Array(12);
  header.set(PACK_SIGNATURE, 0);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, count);
  return header;
};

/**
 * Compacts up to one run's worth of loose objects into a single immutable
 * R2 pack and repoints their rows at it.
 *
 * Ordering note: the R2 put happens **before** the row flip, so a crash in
 * between leaves an unreferenced pack (harmless, content-addressed, GC-able)
 * rather than rows pointing at bytes that do not exist.
 */
export const runCompactJob = (
  options: CompactJobOptions,
): Effect.Effect<CompactOutcome, StoreError> =>
  Effect.gen(function* () {
    const maxObjects = options.maxObjects ?? MAX_OBJECTS_PER_RUN;
    const maxBytes = options.maxBytes ?? MAX_BYTES_PER_RUN;

    // Oldest-first by oid keeps runs deterministic and re-runnable.
    const rows = yield* options.sql.all<LooseRow>(
      `SELECT oid, type, size, zsize, zdata FROM objects
        WHERE location = 'row' AND staged_push IS NULL
        ORDER BY oid LIMIT ?`,
      maxObjects + 1,
    );
    const eligible = rows.slice(0, maxObjects);
    if (eligible.length === 0) {
      return { moved: 0, bytes: 0, packId: undefined, more: false };
    }

    // Assemble the pack, recording each object's zdata offset as we go.
    const chunks: Array<Uint8Array> = [];
    const placements: Array<{ oid: string; offset: number; zsize: number }> =
      [];
    let offset = 0;
    let budget = 0;
    const push = (bytes: Uint8Array) => {
      chunks.push(bytes);
      offset += bytes.length;
    };

    const included: Array<LooseRow> = [];
    for (const row of eligible) {
      if (row.zdata === null) continue; // location='row' with NULL zdata: skip
      const zdata = new Uint8Array(row.zdata);
      if (budget > 0 && budget + zdata.length > maxBytes) break;
      included.push(row);
      budget += zdata.length;
      push(
        yield* Effect.sync(() =>
          // Row types are the 1..4 non-delta git types (the ingest path only
          // ever stores those), which is exactly `PackEntryType`.
          encodeTypeSize(row.type as PackEntryType, row.size),
        ),
      );
      placements.push({ oid: row.oid, offset, zsize: zdata.length });
      push(zdata);
    }
    if (included.length === 0) {
      return { moved: 0, bytes: 0, packId: undefined, more: false };
    }

    const header = packHeader(included.length);
    const body = [header, ...chunks];
    // One pass: the raw digest is the pack trailer, its hex is the pack id
    // (content-addressed, so a retried run rewrites the identical key).
    const trailer = yield* Effect.sync(() => {
      const hash = makeSha1();
      for (const chunk of body) hash.update(chunk);
      return hash.digest();
    });
    const trailerHex = yield* Effect.sync(() => bytesToHex(trailer));

    const total =
      body.reduce((sum, chunk) => sum + chunk.length, 0) + trailer.length;
    const pack = yield* Effect.sync(() => {
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of body) {
        out.set(chunk, at);
        at += chunk.length;
      }
      out.set(trailer, at);
      return out;
    });

    // Offsets recorded above are relative to the start of the entry stream;
    // shift them past the 12-byte header to get absolute file offsets.
    const packId = trailerHex;
    const key = packKey(options.repoId, packId);
    yield* runR2(`R2 put ${key}`)(
      options.bucket.put(key, pack, { contentLength: pack.length }),
    );

    yield* options.sql
      .transactionSync((raw) => {
        for (const placement of placements) {
          raw.exec(
            `UPDATE objects
                SET location = 'pack', pack_id = ?, pack_offset = ?, zdata = NULL
              WHERE oid = ? AND location = 'row' AND staged_push IS NULL`,
            packId,
            placement.offset + header.length,
            placement.oid,
          );
        }
      })
      .pipe(Effect.asVoid);

    return {
      moved: included.length,
      bytes: budget,
      packId,
      more: rows.length > maxObjects || included.length < eligible.length,
    };
  });

/**
 * True when the repo has enough loose bytes/objects to be worth compacting
 * (DESIGN.md §12.1 thresholds).
 */
export const shouldCompact = (
  sql: SqlClient,
  options?: {
    readonly bytesThreshold?: number | undefined;
    readonly countThreshold?: number | undefined;
  },
): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    const row = yield* sql.first<{ n: number; bytes: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(zsize), 0) AS bytes
         FROM objects WHERE location = 'row' AND staged_push IS NULL`,
    );
    if (row === undefined) return false;
    return (
      row.bytes >= (options?.bytesThreshold ?? COMPACT_BYTES_THRESHOLD) ||
      row.n >= (options?.countThreshold ?? COMPACT_COUNT_THRESHOLD)
    );
  });
