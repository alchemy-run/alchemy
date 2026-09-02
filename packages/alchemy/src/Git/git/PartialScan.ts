/**
 * Scans pack entries out of a BUFFER that starts at an entry boundary and
 * may end mid-entry (DESIGN §22.7): the unit of work a hashing Worker
 * receives from the receive-pack pipeline — one spilled part plus the
 * carry-over of the previous part's incomplete tail.
 *
 * Everything that can be settled inside the buffer is settled here:
 * non-delta entries are inflated and hashed (the expensive part of
 * ingest), OFS/REF deltas whose base is in the same buffer are applied,
 * re-deflated and hashed. Deltas whose base lies outside the buffer are
 * reported as `unresolved` with what the caller needs to settle them
 * later. The scan stops at the first entry that does not fit; `consumedTo`
 * is the absolute offset where it starts, so the caller can carry the tail.
 * An entry only counts as fitting when the buffer extends at least one byte
 * past it, so the buffer must always end with what FOLLOWS the last entry
 * to consume (the next part's bytes, or the pack trailer).
 *
 * Pure: no store, no I/O. The trailer is NOT verified here (the caller
 * hashes the whole pack as it streams).
 */
import * as Effect from "effect/Effect";
import { applyDelta } from "./Delta.ts";
import {
  bytesToHex,
  decodeOfsDeltaOffset,
  decodeTypeSize,
  hashObjectSync,
  ObjectParseError,
  type ObjectType,
  type Oid,
} from "./ObjectCodec.ts";
import { deflate, inflateEntrySync, type InflatedEntry } from "./Zlib.ts";
import { ObjectTooLargeError, PackFormatError } from "./PackParser.ts";

export interface ScannedEntry {
  readonly oid: Oid;
  readonly type: ObjectType;
  /** Absolute pack offset of the entry HEADER (what OFS_DELTAs point at). */
  readonly offset: number;
  /** Uncompressed size. */
  readonly size: number;
  /** Absolute pack offset of the entry's zdata (its header precedes it). */
  readonly dataOffset: number;
  /** Compressed span at `dataOffset` — verbatim for non-delta entries. */
  readonly span: number;
  /** Set for delta-resolved entries: a fresh deflate to store as the row. */
  readonly zdata?: Uint8Array | undefined;
  /** Inflated content for commits, trees and tags (the store parses them). */
  readonly content?: Uint8Array | undefined;
}

export interface UnresolvedDelta {
  /** Absolute pack offset of the entry header. */
  readonly offset: number;
  /** Absolute offset of the delta payload's zdata and its span. */
  readonly dataOffset: number;
  readonly span: number;
  /** The base: an absolute pack offset (OFS_DELTA) or an oid (REF_DELTA). */
  readonly baseOffset?: number | undefined;
  readonly baseOid?: Oid | undefined;
  /** Declared (uncompressed) size of the delta payload. */
  readonly size: number;
}

export interface ScanResult {
  readonly entries: ReadonlyArray<ScannedEntry>;
  readonly unresolved: ReadonlyArray<UnresolvedDelta>;
  /** Absolute offset of the first entry NOT consumed (carry from here). */
  readonly consumedTo: number;
  /** Entries consumed (resolved + unresolved). */
  readonly count: number;
}

const isDelta = (type: number) => type === 6 || type === 7;

/**
 * Scans `buf`, whose byte 0 is at absolute pack offset `base`. `remaining`
 * is how many entries the pack still owes (so a trailing partial entry
 * beyond the count is not mistaken for data); `maxObjectSize` bounds
 * inflated sizes.
 */
export const scanPart = (
  buf: Uint8Array,
  options: {
    readonly base: number;
    readonly remaining: number;
    readonly maxObjectSize: number;
    /** Resolved content LRU budget for in-buffer delta bases. */
    readonly cacheBytes?: number | undefined;
  },
): Effect.Effect<ScanResult, PackFormatError | ObjectTooLargeError> =>
  Effect.gen(function* () {
    const entries: Array<ScannedEntry> = [];
    const unresolved: Array<UnresolvedDelta> = [];
    // Content of resolved entries in this buffer, by absolute offset and by
    // oid, for in-buffer delta bases. Bounded; a miss becomes unresolved.
    const byOffset = new Map<
      number,
      { type: ObjectType; content: Uint8Array }
    >();
    const byOid = new Map<string, { type: ObjectType; content: Uint8Array }>();
    let cached = 0;
    const budget = options.cacheBytes ?? 20 * 1024 * 1024;
    const remember = (
      offset: number,
      oid: Oid,
      type: ObjectType,
      content: Uint8Array,
    ) => {
      if (content.length > budget / 4) return;
      while (cached + content.length > budget && byOffset.size > 0) {
        const oldest = byOffset.keys().next().value!;
        const dropped = byOffset.get(oldest)!;
        byOffset.delete(oldest);
        cached -= dropped.content.length;
      }
      byOffset.set(offset, { type, content });
      byOid.set(oid, { type, content });
      cached += content.length;
    };

    let pos = 0;
    let count = 0;
    while (count < options.remaining && pos < buf.length) {
      const offset = options.base + pos;
      let header;
      try {
        header = decodeTypeSize(buf, pos);
      } catch (error) {
        // A header cut by the buffer edge: stop here, carry the tail.
        if (buf.length - pos < 16) break;
        return yield* new PackFormatError({
          reason:
            error instanceof ObjectParseError
              ? `entry at ${offset}: ${error.reason}`
              : `entry at ${offset}: ${String(error)}`,
        });
      }
      if (header.size > options.maxObjectSize) {
        return yield* new ObjectTooLargeError({
          size: header.size,
          limit: options.maxObjectSize,
        });
      }
      let at = header.next;
      let baseOffset: number | undefined;
      let baseOid: Oid | undefined;
      if (header.type === 6) {
        let ofs;
        try {
          ofs = decodeOfsDeltaOffset(buf, at);
        } catch {
          if (buf.length - at < 16) break;
          return yield* new PackFormatError({
            reason: `entry at ${offset}: bad ofs-delta`,
          });
        }
        at = ofs.next;
        baseOffset = offset - ofs.value;
      } else if (header.type === 7) {
        if (at + 20 > buf.length) break;
        baseOid = bytesToHex(buf.subarray(at, at + 20)) as Oid;
        at += 20;
      }
      const inflated: InflatedEntry | undefined = inflateEntrySync(buf, at, {
        maxOutput: options.maxObjectSize,
        expectedSize: header.size,
      });
      if (inflated === undefined) {
        // The compressed stream runs past the buffer (or is corrupt — the
        // next attempt, with more bytes, decides): carry from this entry.
        break;
      }
      const { bytesConsumed, content: payload } = inflated;
      // A stream cut inside its last bytes (end-of-block bits, adler32) can
      // inflate to exactly the declared size without having ended, and the
      // consumed count would then be short. An entry is complete only when
      // the buffer extends PAST it: callers always append what follows
      // (the next part, or the pack trailer for the last one).
      if (at + bytesConsumed >= buf.length) break;
      if (payload.length !== header.size) {
        return yield* new PackFormatError({
          reason: `entry at ${offset}: inflated ${payload.length} bytes, header declared ${header.size}`,
        });
      }
      const dataOffset = options.base + at;
      if (!isDelta(header.type)) {
        const type = header.type as ObjectType;
        const oid = hashObjectSync(type, payload);
        entries.push({
          oid,
          type,
          offset,
          size: payload.length,
          dataOffset,
          span: bytesConsumed,
          content: type === 3 ? undefined : payload,
        });
        remember(offset, oid, type, payload);
      } else {
        const found =
          baseOffset !== undefined
            ? byOffset.get(baseOffset)
            : byOid.get(baseOid!);
        if (found === undefined) {
          unresolved.push({
            offset,
            dataOffset,
            span: bytesConsumed,
            baseOffset,
            baseOid,
            size: header.size,
          });
        } else {
          const content = yield* applyDelta(found.content, payload).pipe(
            Effect.mapError(
              (error) =>
                new PackFormatError({
                  reason: `entry at ${offset}: ${error.reason}`,
                }),
            ),
          );
          if (content.length > options.maxObjectSize) {
            return yield* new ObjectTooLargeError({
              size: content.length,
              limit: options.maxObjectSize,
            });
          }
          const oid = hashObjectSync(found.type, content);
          const zdata = yield* deflate(content).pipe(
            Effect.mapError(
              (error) => new PackFormatError({ reason: error.reason }),
            ),
          );
          entries.push({
            oid,
            type: found.type,
            offset,
            size: content.length,
            dataOffset,
            span: bytesConsumed,
            zdata,
            content: found.type === 3 ? undefined : content,
          });
          remember(offset, oid, found.type, content);
        }
      }
      pos = at + bytesConsumed;
      count += 1;
    }
    return { entries, unresolved, consumedTo: options.base + pos, count };
  });
