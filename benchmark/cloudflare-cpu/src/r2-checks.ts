import type * as Cloudflare from "alchemy/Cloudflare";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

class R2CheckFailure extends Data.TaggedError("R2CheckFailure")<{
  readonly message: string;
}> {}

const assert = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new R2CheckFailure({ message }));

/**
 * Untimed, real-binding checks. Every object is at most sixteen bytes and all
 * keys live under checks/ in the benchmark's forceDestroy bucket. No retries.
 */
export const runR2Checks = (r2: Cloudflare.R2.ReadWriteBucketClient) =>
  Effect.gen(function* () {
    const fixture = Uint8Array.from({ length: 16 }, (_, index) => index);
    const sourceKey = "checks/source";
    const emptyKey = "checks/empty-source";
    const checked: Array<{
      name: string;
      status: "passed" | "failed";
      details?: unknown;
      error?: { tag: string; message: string };
    }> = [];

    const source = (key = sourceKey, options?: Cloudflare.R2.GetOptions) =>
      Effect.gen(function* () {
        const object = yield* r2.get(key, options);
        if (object === null)
          return yield* Effect.fail(new R2CheckFailure({ message: `Missing ${key}` }));
        return object;
      });

    const checkBytes = (key: string, expected: Uint8Array) =>
      Effect.gen(function* () {
        const object = yield* source(key);
        const bytes = yield* object.bytes();
        yield* assert(
          object.size === expected.length && bytes.length === expected.length,
          `Unexpected size for ${key}`,
        );
        yield* assert(
          bytes.every((value, index) => value === expected[index]),
          `Unexpected bytes for ${key}`,
        );
        return { bytes: bytes.length, checksum: bytes.reduce((sum, value) => sum + value, 0) };
      });

    // Retain typed failure details. A defect remains a defect instead of being
    // reclassified as an expected service error.
    const rejectedPut = <A, R>(operation: Effect.Effect<A, Cloudflare.R2.R2Error, R>) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(operation);
        if (Result.isSuccess(result)) {
          return yield* Effect.fail(new R2CheckFailure({ message: "Put unexpectedly succeeded" }));
        }
        return { rejectedWith: result.failure._tag, message: result.failure.message };
      });

    yield* r2.put(sourceKey, fixture);
    yield* r2.put(emptyKey, new Uint8Array());
    yield* r2.delete(["checks/wrong-length", "checks/wrong-sha256"]);

    const empty = yield* Effect.result(
      Effect.gen(function* () {
        const object = yield* source(emptyKey);
        const copied = yield* r2.put("checks/empty-copy", object.body, { contentLength: 0 });
        yield* assert(copied.size === 0, "Empty body copied with nonzero size");
        return yield* checkBytes("checks/empty-copy", new Uint8Array());
      }),
    );
    checked.push(
      Result.isSuccess(empty)
        ? { name: "empty-body-copy", status: "passed", details: empty.success }
        : {
            name: "empty-body-copy",
            status: "failed",
            error: { tag: empty.failure._tag, message: empty.failure.message },
          },
    );

    const ranged = yield* Effect.result(
      Effect.gen(function* () {
        const object = yield* source(sourceKey, { range: { offset: 4, length: 7 } });
        const copied = yield* r2.put("checks/ranged-copy", object.body, { contentLength: 7 });
        yield* assert(copied.size === 7, "Range copy did not use the actual seven-byte length");
        return yield* checkBytes("checks/ranged-copy", fixture.slice(4, 11));
      }),
    );
    checked.push(
      Result.isSuccess(ranged)
        ? { name: "ranged-body-copy", status: "passed", details: ranged.success }
        : {
            name: "ranged-body-copy",
            status: "failed",
            error: { tag: ranged.failure._tag, message: ranged.failure.message },
          },
    );

    const wrongLength = yield* Effect.result(
      Effect.gen(function* () {
        const object = yield* source();
        return yield* rejectedPut(
          r2.put("checks/wrong-length", object.body, { contentLength: 15 }),
        );
      }),
    );
    checked.push(
      Result.isSuccess(wrongLength)
        ? { name: "wrong-content-length-rejected", status: "passed", details: wrongLength.success }
        : {
            name: "wrong-content-length-rejected",
            status: "failed",
            error: { tag: wrongLength.failure._tag, message: wrongLength.failure.message },
          },
    );

    const wrongChecksum = yield* Effect.result(
      Effect.gen(function* () {
        const object = yield* source();
        return yield* rejectedPut(
          r2.put("checks/wrong-sha256", object.body, {
            contentLength: 16,
            sha256: "0".repeat(64),
          }),
        );
      }),
    );
    checked.push(
      Result.isSuccess(wrongChecksum)
        ? { name: "wrong-sha256-rejected", status: "passed", details: wrongChecksum.success }
        : {
            name: "wrong-sha256-rejected",
            status: "failed",
            error: { tag: wrongChecksum.failure._tag, message: wrongChecksum.failure.message },
          },
    );

    const transformed = yield* Effect.result(
      Effect.gen(function* () {
        const object = yield* source();
        const body = object.body.pipe(Stream.map((chunk) => chunk.map((value) => value ^ 255)));
        const copied = yield* r2.put("checks/transformed-copy", body, { contentLength: 16 });
        yield* assert(copied.size === 16, "Transformed copy changed size");
        return yield* checkBytes(
          "checks/transformed-copy",
          fixture.map((value) => value ^ 255),
        );
      }),
    );
    checked.push(
      Result.isSuccess(transformed)
        ? {
            name: "transformed-stream-preserves-changed-bytes",
            status: "passed",
            details: transformed.success,
          }
        : {
            name: "transformed-stream-preserves-changed-bytes",
            status: "failed",
            error: { tag: transformed.failure._tag, message: transformed.failure.message },
          },
    );

    const conditional = yield* Effect.result(
      Effect.gen(function* () {
        const preserved = new Uint8Array([90, 91, 92, 93]);
        yield* r2.put("checks/conditional-destination", preserved);
        const object = yield* source();
        const rejected = yield* r2.put("checks/conditional-destination", object.body, {
          contentLength: 16,
          onlyIf: { etagMatches: "0".repeat(32) },
        });
        yield* assert(rejected === null, "Unmet ETag condition did not return null");
        return yield* checkBytes("checks/conditional-destination", preserved);
      }),
    );
    checked.push(
      Result.isSuccess(conditional)
        ? {
            name: "failed-only-if-preserves-destination",
            status: "passed",
            details: conditional.success,
          }
        : {
            name: "failed-only-if-preserves-destination",
            status: "failed",
            error: { tag: conditional.failure._tag, message: conditional.failure.message },
          },
    );

    return {
      ok: checked.every((check) => check.status === "passed"),
      operation: "r2-checks",
      fixtureBytes: 16,
      maxObjectBytes: 16,
      checked,
    };
  });
