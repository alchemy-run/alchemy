/**
 * The zlib boundary — the ONLY module in `src/git/` allowed to touch
 * `node:zlib` (per DESIGN §7).
 *
 * | Need                                          | Tool                          |
 * |-----------------------------------------------|-------------------------------|
 * | Pack entry parsing (unknown compressed span)  | `createInflate()` per entry   |
 * | One-shot inflate of an exactly-known span     | `inflateSync`                 |
 * | Compression at rest (delta-resolved objects)  | `deflateSync` (level 6)       |
 *
 * The streaming-inflate trick (workerd-verified on 1.20260801.1): each pack
 * entry's zlib stream (RFC 1950) is self-terminating; `createInflate()`'s
 * `end` event fires at `Z_STREAM_END` mid-`write` without `.end()`, and
 * `inflate.bytesWritten` then reports the **exact compressed bytes
 * consumed** — the only way to find the next entry.
 * `DecompressionStream("deflate")` is disqualified for this: it errors on
 * trailing bytes and does not report consumption.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import zlib from "node:zlib";

/**
 * Error raised on zlib failures: corrupt streams, truncated input, or an
 * inflated output exceeding the caller's cap.
 */
export class ZlibError extends Schema.TaggedError<ZlibError>()("ZlibError", {
  reason: Schema.String,
}) {}

/**
 * The result of inflating one pack entry: the inflated content and the exact
 * number of compressed bytes consumed from the input (which locates the next
 * entry).
 */
export interface InflatedEntry {
  readonly content: Uint8Array;
  readonly bytesConsumed: number;
}

/** Feed granularity for the streaming inflater. */
const CHUNK = 65536;

/**
 * Streaming-inflates exactly one zlib stream from `buf` starting at
 * `offset`, tolerating arbitrary trailing bytes (the next pack entries).
 *
 * Input is fed in 64 KiB chunks; when the stream reaches `Z_STREAM_END` the
 * `end` event fires and `bytesWritten` gives the exact compressed span.
 * Truncated input (no `Z_STREAM_END` before the buffer ends) and corrupt
 * streams fail with {@link ZlibError}, as does output growing past
 * `options.maxOutput`.
 */
export const inflateEntry = (
  buf: Uint8Array,
  offset: number,
  options?: { readonly maxOutput?: number | undefined },
): Effect.Effect<InflatedEntry, ZlibError> =>
  Effect.callback<InflatedEntry, ZlibError>((resume) => {
    if (offset < 0 || offset >= buf.length) {
      resume(
        Effect.fail(
          new ZlibError({
            reason: `inflate offset ${offset} out of range (buffer ${buf.length})`,
          }),
        ),
      );
      return;
    }
    const maxOutput = options?.maxOutput;
    const inflater = zlib.createInflate();
    const chunks: Array<Uint8Array> = [];
    let outBytes = 0;
    let settled = false;

    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      resume(Effect.fail(new ZlibError({ reason })));
    };

    inflater.on("data", (chunk: Uint8Array) => {
      if (settled) return;
      outBytes += chunk.length;
      if (maxOutput !== undefined && outBytes > maxOutput) {
        fail(`inflated output exceeds ${maxOutput} bytes`);
        return;
      }
      chunks.push(chunk);
    });
    inflater.on("error", (error: Error) => {
      fail(`inflate failed at offset ${offset}: ${error.message}`);
    });
    inflater.once("end", () => {
      if (settled) return;
      settled = true;
      const bytesConsumed = inflater.bytesWritten;
      const content = new Uint8Array(outBytes);
      let pos = 0;
      for (const chunk of chunks) {
        content.set(chunk, pos);
        pos += chunk.length;
      }
      inflater.destroy();
      resume(Effect.succeed({ content, bytesConsumed }));
    });

    const end = buf.length;
    let pos = offset;
    const feed = (): void => {
      if (settled) return;
      if (pos >= end) {
        // ran out of input without Z_STREAM_END — flushing EOF surfaces the
        // "unexpected end of file" error through the error handler above.
        inflater.end();
        return;
      }
      const next = Math.min(pos + CHUNK, end);
      const chunk = buf.subarray(pos, next);
      pos = next;
      inflater.write(chunk, () => feed());
    };
    feed();

    return Effect.sync(() => {
      // interruption: tear the native stream down
      if (!settled) {
        settled = true;
        inflater.destroy();
      }
    });
  });

/**
 * One-shot inflate of an exactly-known zlib span (e.g. a stored `zdata`
 * BLOB). Strict: trailing garbage or truncation fails.
 */
export const inflate = (
  data: Uint8Array,
): Effect.Effect<Uint8Array, ZlibError> =>
  Effect.try({
    try: () => new Uint8Array(zlib.inflateSync(data)),
    catch: (error) =>
      new ZlibError({
        reason: `inflateSync failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

/**
 * One-shot deflate at the given level (default 6 — the at-rest compression
 * level for delta-resolved objects; non-delta pack entries are stored
 * verbatim and never re-compressed).
 */
export const deflate = (
  data: Uint8Array,
  level = 6,
): Effect.Effect<Uint8Array, ZlibError> =>
  Effect.try({
    try: () => new Uint8Array(zlib.deflateSync(data, { level })),
    catch: (error) =>
      new ZlibError({
        reason: `deflateSync failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
