/**
 * Receiving a git wire request body (DESIGN.md §3.6, §22.6, §22.10).
 *
 * A push body must NEVER be materialized: `request.arrayBuffer` on a
 * 100 MiB pack inside a 128 MB isolate is an OOM (the failure that rejected
 * the full alchemy-history push with a 500). The body is fed chunk by
 * chunk into a {@link StreamingFeeder} the parser reads from as bytes
 * arrive; the parser ends the body's life in memory by dispatching it in
 * uniform parts to the hasher isolates, which write the parts to blob
 * storage (the spill) while verifying them.
 *
 * The command section of a receive-pack request lives in the first bytes,
 * so the first {@link HEAD_BYTES} are enough to parse the ref commands
 * before the pack has arrived.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { StoreError } from "../git/Store.ts";
import type { StreamingFeeder } from "./StreamingSource.ts";

/** Head prefix that is enough for command-section parsing. */
export const HEAD_BYTES = 1024 * 1024;

/**
 * Uniform multipart part size — also the hasher part size, since each
 * hasher isolate writes the part it verifies (DESIGN §22.10). 8 MiB is
 * above R2's 5 MiB minimum and its 10,000-part limit still allows ~78 GiB.
 */
export const SPILL_PART_BYTES = 8 * 1024 * 1024;

/**
 * Feeds a request body into the streaming source and ends it when the
 * body ends. Resolves with the total; a read failure fails the feeder so
 * every waiting reader wakes with the error.
 */
export const feedBody = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  feeder: StreamingFeeder,
): Effect.Effect<{ readonly total: number }, StoreError> =>
  Effect.suspend(() => {
    let total = 0;
    return Stream.runForEach(
      stream.pipe(
        Stream.mapError(
          (error) =>
            new StoreError({ reason: `incoming body read: ${String(error)}` }),
        ),
      ),
      (chunk) =>
        Effect.gen(function* () {
          yield* feeder.push(chunk);
          total += chunk.length;
        }),
    ).pipe(
      Effect.map(() => {
        feeder.end();
        return { total };
      }),
      Effect.tapError((error) => Effect.sync(() => feeder.fail(error))),
    );
  });
