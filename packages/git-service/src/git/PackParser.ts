/**
 * Pack ingestion (DESIGN §3.6): a single pass over a pack held behind a
 * {@link RandomAccess} source, under the push semaphore.
 *
 * 1. Validate `PACK`, version 2, count.
 * 2. Per entry: parse the type/size varint header. Non-delta entries are
 *    streaming-inflated (`Zlib.inflateEntry` — `bytesWritten` gives the exact
 *    compressed span), hashed as `sha1("<type> <size>\0" + content)`, and the
 *    **compressed span is kept verbatim as `zdata`** — no recompression.
 *    Deltas (OFS with the +1-bias offset decoding, REF with a 20-byte base
 *    id) resolve their base from (a) already-ingested entries via a bounded
 *    LRU of resolved contents, (b) re-inflation from the pack on cache miss,
 *    or (c) the object store for thin bases (REF_DELTA to a prior push — the
 *    normal case). The copy/insert instruction stream is applied
 *    (`size==0 ⇒ 0x10000`), the result size verified, the result hashed and
 *    `deflate`d (level 6) for storage.
 * 3. The trailing pack SHA-1 is verified.
 *
 * Resolved entries are emitted to a caller-provided sink as they are
 * produced; the caller (the Repo DO) stages them with `staged_push = pushId`.
 *
 * The parser is written against {@link RandomAccess} from day one so the
 * v1.x streaming upgrade (R2-multipart tee + ranged reads) swaps one
 * implementation, not the protocol code (DESIGN §3.6 upgrade seam).
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { applyDelta, DeltaFormatError } from "./Delta.ts";
import {
  bytesToHex,
  decodeOfsDeltaOffset,
  decodeTypeSize,
  hashObject,
  isDeltaType,
  makeSha1,
  ObjectParseError,
  type ObjectType,
  type Oid,
  type PackEntryType,
} from "./ObjectCodec.ts";
import { type ObjectSource, StoreError } from "./Store.ts";
import { deflate, inflate, inflateEntry, ZlibError } from "./Zlib.ts";

// ─────────────────────────────────────────────────────────────────────────────
// RandomAccess
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Random access over a pack's raw bytes. v1 backs this with the buffered
 * request body ({@link bufferRandomAccess}); the v1.x streaming upgrade backs
 * it with R2 ranged reads without touching the parser.
 */
export interface RandomAccess {
  /** Total size of the pack in bytes. */
  readonly size: number;
  /**
   * Reads up to `length` bytes at `offset`. May return fewer bytes only when
   * the range extends past the end of the pack. Implementations should return
   * views cheaply (no copy) where possible; callers copy what they retain.
   */
  readonly read: (
    offset: number,
    length: number,
  ) => Effect.Effect<Uint8Array, StoreError>;
}

/**
 * A {@link RandomAccess} over an in-memory buffer. Reads return subarray
 * views (zero copy).
 */
export const bufferRandomAccess = (buf: Uint8Array): RandomAccess => ({
  size: buf.length,
  read: (offset, length) =>
    Effect.sync(() =>
      buf.subarray(offset, Math.min(offset + length, buf.length)),
    ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Error raised on malformed pack structure: bad magic/version, truncated
 * entries, entry-count mismatch, size mismatches, or an OFS_DELTA offset that
 * does not land on an entry boundary.
 */
export class PackFormatError extends Schema.TaggedError<PackFormatError>()(
  "PackFormatError",
  { reason: Schema.String },
) {}

/**
 * Error raised when the trailing pack SHA-1 does not match the hash of the
 * preceding bytes (`unpack pack checksum mismatch` on the wire).
 */
export class PackChecksumMismatch extends Schema.TaggedError<PackChecksumMismatch>()(
  "PackChecksumMismatch",
  { expected: Schema.String, actual: Schema.String },
) {}

/**
 * Error raised when an object (or a delta result) exceeds the per-object
 * uncompressed size cap (64 MiB in v1 — DESIGN §3.3).
 */
export class ObjectTooLargeError extends Schema.TaggedError<ObjectTooLargeError>()(
  "ObjectTooLargeError",
  {
    size: Schema.Number,
    limit: Schema.Number,
    oid: Schema.optional(Schema.String),
  },
) {}

/**
 * Error raised when a REF_DELTA's base cannot be found in the pack or in the
 * object store (a thin pack whose base we do not have).
 */
export class MissingDeltaBaseError extends Schema.TaggedError<MissingDeltaBaseError>()(
  "MissingDeltaBaseError",
  { baseOid: Schema.String },
) {}

/**
 * The full error union pack ingestion can produce.
 */
export type PackIngestError =
  | PackFormatError
  | PackChecksumMismatch
  | ObjectTooLargeError
  | MissingDeltaBaseError
  | ZlibError
  | DeltaFormatError
  | ObjectParseError
  | StoreError;

// ─────────────────────────────────────────────────────────────────────────────
// Resolved entries / options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One fully resolved object produced by pack ingestion.
 *
 * `zdata` is `zlib(content)` **without** the loose header — for non-delta
 * entries it is the pack's compressed span verbatim; for delta-resolved
 * entries it is a fresh `deflate(content)` at level 6.
 */
export interface ResolvedEntry {
  readonly oid: Oid;
  readonly type: ObjectType;
  /** Uncompressed size in bytes. */
  readonly size: number;
  /** `zlib(content)`, no loose header. Safe to retain (always a copy). */
  readonly zdata: Uint8Array;
  /** `true` when the entry arrived as a delta and was re-deflated. */
  readonly fromDelta: boolean;
}

/**
 * Summary returned by {@link ingestPack} after the trailer verifies.
 */
export interface IngestSummary {
  /** Number of entries in the pack (the header count). */
  readonly count: number;
  /** The oids of every resolved entry, in emission order. */
  readonly oids: ReadonlyArray<Oid>;
}

/** Default per-object uncompressed size cap: 64 MiB (DESIGN §3.3). */
export const DEFAULT_MAX_OBJECT_SIZE = 64 * 1024 * 1024;

/** Default resolved-content LRU budget: 20 MiB (DESIGN §3.6). */
export const DEFAULT_CACHE_BYTES = 20 * 1024 * 1024;

/** Per-entry cache admission cap: entries larger than this are never cached. */
const MAX_CACHE_ENTRY_BYTES = 10 * 1024 * 1024;

/**
 * Options for {@link ingestPack}.
 */
export interface IngestPackOptions<E, R> {
  /** The pack bytes. */
  readonly source: RandomAccess;
  /** Live object store, used to resolve thin REF_DELTA bases. */
  readonly store: ObjectSource;
  /** Receives each resolved entry as it is produced (staging inserts). */
  readonly sink: (entry: ResolvedEntry) => Effect.Effect<void, E, R>;
  /** Per-object uncompressed cap; default {@link DEFAULT_MAX_OBJECT_SIZE}. */
  readonly maxObjectSize?: number | undefined;
  /** Resolved-content LRU budget; default {@link DEFAULT_CACHE_BYTES}. */
  readonly cacheBytes?: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

interface CachedContent {
  readonly type: ObjectType;
  readonly content: Uint8Array;
}

/** Insertion-order LRU bounded by total content bytes. */
class ByteLru {
  private readonly map = new Map<string, CachedContent>();
  private bytes = 0;
  constructor(private readonly capacity: number) {}

  get(key: string): CachedContent | undefined {
    const hit = this.map.get(key);
    if (hit !== undefined) {
      // refresh recency
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, entry: CachedContent): void {
    if (entry.content.length > MAX_CACHE_ENTRY_BYTES) return;
    if (this.map.has(key)) return;
    this.map.set(key, entry);
    this.bytes += entry.content.length;
    while (this.bytes > this.capacity && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string;
      const evicted = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.bytes -= evicted.content.length;
    }
  }
}

interface IndexedEntry {
  /** Absolute offset of the entry header in the pack. */
  readonly offset: number;
  readonly entryType: PackEntryType;
  /** Declared uncompressed size (for deltas: of the delta payload). */
  readonly declaredSize: number;
  /** Absolute offset of the zlib stream. */
  readonly dataOffset: number;
  /** Exact compressed span in bytes. */
  readonly span: number;
  /** OFS_DELTA: absolute offset of the base entry. */
  readonly baseOffset: number | undefined;
  /** REF_DELTA: base object id. */
  readonly baseOid: Oid | undefined;
  /** Set once the entry has been resolved and emitted. */
  resolved?: { readonly oid: Oid; readonly type: ObjectType };
}

const readU32BE = (buf: Uint8Array, offset: number): number =>
  ((buf[offset]! << 24) |
    (buf[offset + 1]! << 16) |
    (buf[offset + 2]! << 8) |
    buf[offset + 3]!) >>>
  0;

/**
 * Reads and validates the 12-byte pack header (`PACK`, version 2, entry
 * count).
 */
export const readPackHeader = Effect.fn(function* (source: RandomAccess) {
  if (source.size < 12 + 20) {
    return yield* new PackFormatError({
      reason: `pack too small: ${source.size} bytes`,
    });
  }
  const header = yield* source.read(0, 12);
  if (
    header.length < 12 ||
    header[0] !== 0x50 || // P
    header[1] !== 0x41 || // A
    header[2] !== 0x43 || // C
    header[3] !== 0x4b // K
  ) {
    return yield* new PackFormatError({ reason: "bad pack magic" });
  }
  const version = readU32BE(header, 4);
  if (version !== 2) {
    return yield* new PackFormatError({
      reason: `unsupported pack version ${version}`,
    });
  }
  const count = readU32BE(header, 8);
  return { version, count };
});

// ─────────────────────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ingests a complete pack: parses every entry, resolves OFS/REF deltas
 * (including thin bases from the object store), verifies the trailing SHA-1,
 * and emits each resolved object to `options.sink`.
 *
 * Entries are emitted in pack order, except REF_DELTA entries whose base
 * appears *later* in the pack (legal but rare) — those are deferred and
 * emitted after the main pass.
 *
 * Memory: the resolved-content LRU is bounded by `cacheBytes`; cache misses
 * re-inflate from the source. Only one resolved object (plus its base) is
 * otherwise live at a time.
 */
export const ingestPack = <E, R>(
  options: IngestPackOptions<E, R>,
): Effect.Effect<IngestSummary, PackIngestError | E, R> =>
  Effect.gen(function* () {
    const { sink, source, store } = options;
    const maxObjectSize = options.maxObjectSize ?? DEFAULT_MAX_OBJECT_SIZE;
    const cache = new ByteLru(options.cacheBytes ?? DEFAULT_CACHE_BYTES);
    const { count } = yield* readPackHeader(source);
    const dataEnd = source.size - 20;

    const byOffset = new Map<number, IndexedEntry>();
    /** oid → entry offset, for in-pack REF_DELTA base lookup. */
    const offsetByOid = new Map<Oid, number>();
    const oids: Array<Oid> = [];
    const deferred: Array<IndexedEntry> = [];

    /** Inflates an already-indexed entry's own zlib stream (exact span). */
    const inflateOwn = (entry: IndexedEntry) =>
      source
        .read(entry.dataOffset, entry.span)
        .pipe(Effect.flatMap((z) => inflate(z)));

    /**
     * Resolves an entry to its full content, walking delta chains. Bases come
     * from the LRU, from re-inflation of earlier pack entries, or (thin
     * REF_DELTA) from the object store.
     */
    const resolveContent = (
      entry: IndexedEntry,
    ): Effect.Effect<CachedContent, PackIngestError> =>
      Effect.gen(function* () {
        const key = `ofs:${entry.offset}`;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        let result: CachedContent;
        if (!isDeltaType(entry.entryType)) {
          const content = yield* inflateOwn(entry);
          result = { type: entry.entryType as ObjectType, content };
        } else {
          const base = yield* resolveBase(entry);
          const payload = yield* inflateOwn(entry);
          const content = yield* applyDelta(base.content, payload);
          if (content.length > maxObjectSize) {
            return yield* new ObjectTooLargeError({
              size: content.length,
              limit: maxObjectSize,
            });
          }
          result = { type: base.type, content };
        }
        cache.set(key, result);
        return result;
      });

    /** Resolves a delta entry's base content. */
    const resolveBase = (
      entry: IndexedEntry,
    ): Effect.Effect<CachedContent, PackIngestError> =>
      Effect.gen(function* () {
        if (entry.baseOffset !== undefined) {
          const base = byOffset.get(entry.baseOffset);
          if (base === undefined) {
            return yield* new PackFormatError({
              reason: `ofs-delta at ${entry.offset} points at ${entry.baseOffset}, not an entry boundary`,
            });
          }
          return yield* resolveContent(base);
        }
        const baseOid = entry.baseOid!;
        const inPack = offsetByOid.get(baseOid);
        if (inPack !== undefined) {
          return yield* resolveContent(byOffset.get(inPack)!);
        }
        const cachedThin = cache.get(`oid:${baseOid}`);
        if (cachedThin !== undefined) return cachedThin;
        const meta = yield* store.getMeta(baseOid);
        if (meta === undefined) {
          return yield* new MissingDeltaBaseError({ baseOid });
        }
        if (meta.size > maxObjectSize) {
          return yield* new ObjectTooLargeError({
            size: meta.size,
            limit: maxObjectSize,
            oid: baseOid,
          });
        }
        const content = yield* store.readContent(baseOid);
        const thin: CachedContent = { type: meta.type, content };
        cache.set(`oid:${baseOid}`, thin);
        return thin;
      });

    /** Resolves, hashes, deflates, and emits one delta entry. */
    const emitDelta = (entry: IndexedEntry) =>
      Effect.gen(function* () {
        const { content, type } = yield* resolveContent(entry);
        const oid = yield* hashObject(type, content);
        const zdata = yield* deflate(content);
        entry.resolved = { oid, type };
        offsetByOid.set(oid, entry.offset);
        oids.push(oid);
        yield* sink({
          oid,
          type,
          size: content.length,
          zdata,
          fromDelta: true,
        });
      });

    // ── main pass: index + resolve in pack order ─────────────────────────────
    let offset = 12;
    for (let i = 0; i < count; i++) {
      if (offset >= dataEnd) {
        return yield* new PackFormatError({
          reason: `truncated pack: entry ${i} of ${count} starts past the trailer`,
        });
      }
      const window = yield* source.read(offset, dataEnd - offset);
      let header;
      try {
        header = decodeTypeSize(window, 0);
      } catch (error) {
        return yield* new PackFormatError({
          reason:
            error instanceof ObjectParseError
              ? `entry ${i}: ${error.reason}`
              : `entry ${i}: ${String(error)}`,
        });
      }
      let pos = header.next;
      let baseOffset: number | undefined;
      let baseOid: Oid | undefined;
      if (header.type === 6) {
        let ofs;
        try {
          ofs = decodeOfsDeltaOffset(window, pos);
        } catch (error) {
          return yield* new PackFormatError({
            reason:
              error instanceof ObjectParseError
                ? `entry ${i}: ${error.reason}`
                : `entry ${i}: ${String(error)}`,
          });
        }
        pos = ofs.next;
        baseOffset = offset - ofs.value;
        if (baseOffset < 12) {
          return yield* new PackFormatError({
            reason: `entry ${i}: ofs-delta offset ${ofs.value} points before the first entry`,
          });
        }
      } else if (header.type === 7) {
        if (pos + 20 > window.length) {
          return yield* new PackFormatError({
            reason: `entry ${i}: truncated ref-delta base id`,
          });
        }
        baseOid = bytesToHex(window.subarray(pos, pos + 20));
        pos += 20;
      } else if (header.size > maxObjectSize) {
        return yield* new ObjectTooLargeError({
          size: header.size,
          limit: maxObjectSize,
        });
      }

      const { bytesConsumed, content } = yield* inflateEntry(window, pos, {
        maxOutput: maxObjectSize,
      });
      if (content.length !== header.size) {
        return yield* new PackFormatError({
          reason: `entry ${i}: inflated ${content.length} bytes, header declared ${header.size}`,
        });
      }
      const dataOffset = offset + pos;
      const entry: IndexedEntry = {
        offset,
        entryType: header.type,
        declaredSize: header.size,
        dataOffset,
        span: bytesConsumed,
        baseOffset,
        baseOid,
      };
      byOffset.set(offset, entry);

      if (!isDeltaType(header.type)) {
        const type = header.type as ObjectType;
        const oid = yield* hashObject(type, content);
        // keep the compressed span verbatim — copy it out of the shared buffer
        const zview = yield* source.read(dataOffset, bytesConsumed);
        const zdata = Uint8Array.from(zview);
        entry.resolved = { oid, type };
        offsetByOid.set(oid, entry.offset);
        cache.set(`ofs:${offset}`, { type, content });
        oids.push(oid);
        yield* sink({
          oid,
          type,
          size: content.length,
          zdata,
          fromDelta: false,
        });
      } else if (
        baseOid !== undefined &&
        offsetByOid.get(baseOid) === undefined
      ) {
        // REF_DELTA: base may be a thin base (store) or a later pack entry.
        const result = yield* Effect.result(emitDelta(entry));
        if (Result.isFailure(result)) {
          if (result.failure instanceof MissingDeltaBaseError) {
            deferred.push(entry); // base may appear later in the pack
          } else {
            return yield* Effect.fail(result.failure);
          }
        }
      } else {
        yield* emitDelta(entry);
      }
      offset = dataOffset + bytesConsumed;
    }

    if (offset !== dataEnd) {
      return yield* new PackFormatError({
        reason: `pack has ${dataEnd - offset} unconsumed bytes after ${count} entries`,
      });
    }

    // ── deferred REF_DELTAs (base later in pack): fixpoint passes ────────────
    let pending = deferred;
    while (pending.length > 0) {
      const next: Array<IndexedEntry> = [];
      let firstMissing: MissingDeltaBaseError | undefined;
      for (const entry of pending) {
        const result = yield* Effect.result(emitDelta(entry));
        if (Result.isFailure(result)) {
          if (result.failure instanceof MissingDeltaBaseError) {
            firstMissing ??= result.failure;
            next.push(entry);
          } else {
            return yield* Effect.fail(result.failure);
          }
        }
      }
      if (next.length === pending.length) {
        // no progress — the base genuinely does not exist anywhere
        return yield* Effect.fail(firstMissing!);
      }
      pending = next;
    }

    // ── trailer verification ─────────────────────────────────────────────────
    const sha = yield* Effect.sync(() => makeSha1());
    const CHUNK = 1024 * 1024;
    for (let pos = 0; pos < dataEnd; pos += CHUNK) {
      const chunk = yield* source.read(pos, Math.min(CHUNK, dataEnd - pos));
      yield* Effect.sync(() => sha.update(chunk));
    }
    const trailer = yield* source.read(dataEnd, 20);
    const expected = bytesToHex(trailer);
    const actual = yield* Effect.sync(() => sha.digestHex());
    if (expected !== actual) {
      return yield* new PackChecksumMismatch({ expected, actual });
    }

    return { count, oids } satisfies IngestSummary;
  });
