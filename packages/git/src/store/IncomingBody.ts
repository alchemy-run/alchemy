/**
 * Streaming receive of a git wire request body (DESIGN.md §3.6).
 *
 * A push body must NEVER be materialized in memory: `request.arrayBuffer`
 * on a 100 MiB pack inside a 128 MB Durable Object isolate is an OOM (the
 * failure that rejected the full alchemy-history push with a 500). Instead
 * the body is consumed chunk by chunk:
 *
 * - bodies that finish within `spillThreshold` are returned as one buffer
 *   (the fast path — the overwhelming majority of pushes);
 * - the moment the threshold is crossed, everything received so far and
 *   everything still arriving is spilled to R2 via **multipart upload** in
 *   uniform `partBytes` parts (R2 requires uniform part sizes), so peak
 *   memory is ~`spillThreshold` + one part regardless of the push size.
 *
 * The command section of a receive-pack request lives in the first bytes,
 * so a spilled body still returns a `head` prefix big enough to parse the
 * ref commands; the pack itself is later read back from R2 through bounded
 * windows (`blobRandomAccess`).
 */
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  BlobMultipart,
  BlobStoreError,
  BlobStoreShape,
} from "../BlobStore.ts";
import { StoreError } from "../git/Store.ts";

/** Head prefix retained for command-section parsing on spilled bodies. */
export const HEAD_BYTES = 1024 * 1024;

/**
 * Uniform multipart part size. 8 MiB keeps the part buffer small next to
 * the pre-spill buffer, and R2's 10,000-part limit still allows ~78 GiB.
 */
export const SPILL_PART_BYTES = 8 * 1024 * 1024;

/** Result of {@link receiveWireBody}. */
export interface ReceivedWireBody {
  /**
   * The whole body when it was buffered (`parkedKey === undefined`),
   * otherwise the first {@link HEAD_BYTES} — enough for the pkt-line
   * command section, which precedes the pack.
   */
  readonly head: Uint8Array;
  /** Total body bytes received. */
  readonly total: number;
  /**
   * R2 key holding the full body when it was spilled. The caller owns
   * deletion after ingest.
   */
  readonly parkedKey: string | undefined;
}

/** FIFO byte queue that pops exact-size parts across chunk boundaries. */
const makeByteQueue = () => {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  return {
    get size() {
      return size;
    },
    push(chunk: Uint8Array) {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      size += chunk.length;
    },
    /** Pops exactly `bytes` (caller guarantees availability). */
    pop(bytes: number): Uint8Array {
      const out = new Uint8Array(bytes);
      let written = 0;
      while (written < bytes) {
        const chunk = chunks[0]!;
        const take = Math.min(chunk.length, bytes - written);
        out.set(chunk.subarray(0, take), written);
        if (take === chunk.length) {
          chunks.shift();
        } else {
          chunks[0] = chunk.subarray(take);
        }
        written += take;
      }
      size -= bytes;
      return out;
    },
  };
};

/**
 * Consumes a request-body stream, buffering up to `spillThreshold` bytes
 * in memory and spilling the whole body to R2 beyond that.
 */
export const receiveWireBody = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  options: {
    readonly blobs: BlobStoreShape;
    /** Blob key the body spills to (unused when it fits in memory). */
    readonly key: string;
    readonly spillThreshold: number;
    readonly partBytes?: number | undefined;
  },
): Effect.Effect<ReceivedWireBody, StoreError> =>
  Effect.suspend(() => {
    const partBytes = options.partBytes ?? SPILL_PART_BYTES;
    const queue = makeByteQueue();
    let total = 0;
    const headChunks: Array<Uint8Array> = [];
    let headLen = 0;
    let upload: BlobMultipart | undefined;
    let nextPart = 1;

    const asStoreError = (stage: string) => (error: BlobStoreError) =>
      new StoreError({ reason: `incoming body ${stage}: ${error.reason}` });

    return Effect.gen(function* () {
      yield* Stream.runForEach(
        stream.pipe(
          Stream.mapError(
            (error) =>
              new StoreError({
                reason: `incoming body read: ${String(error)}`,
              }),
          ),
        ),
        (chunk) =>
          Effect.gen(function* () {
            if (headLen < HEAD_BYTES) {
              const take = chunk.subarray(0, HEAD_BYTES - headLen);
              headChunks.push(take);
              headLen += take.length;
            }
            queue.push(chunk);
            total += chunk.length;
            if (upload === undefined && total > options.spillThreshold) {
              upload = yield* options.blobs
                .multipart(options.key)
                .pipe(
                  Effect.mapError(asStoreError("create upload")),
                  Effect.provide(RuntimeContext.phantom),
                );
            }
            while (upload !== undefined && queue.size >= partBytes) {
              yield* upload
                .uploadPart(nextPart++, queue.pop(partBytes))
                .pipe(Effect.mapError(asStoreError("upload part")));
            }
          }),
      );

      if (upload === undefined) {
        // Fits in memory: hand back the single concatenated buffer.
        const bytes = queue.pop(queue.size);
        return { head: bytes, total, parkedKey: undefined };
      }

      if (queue.size > 0) {
        // The final part may be any size ≤ partBytes.
        yield* upload
          .uploadPart(nextPart++, queue.pop(queue.size))
          .pipe(Effect.mapError(asStoreError("upload part")));
      }
      yield* upload.complete.pipe(Effect.mapError(asStoreError("complete")));

      const head = new Uint8Array(headLen);
      let at = 0;
      for (const chunk of headChunks) {
        head.set(chunk, at);
        at += chunk.length;
      }
      return { head, total, parkedKey: options.key };
    }).pipe(
      // A failed receive must not leave a dangling multipart upload —
      // R2 bills incomplete uploads until aborted or lifecycle-expired.
      Effect.onError(() =>
        Effect.suspend(() =>
          upload === undefined ? Effect.void : upload.abort,
        ).pipe(Effect.ignore),
      ),
    );
  });
