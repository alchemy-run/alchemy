import { orderedMultipart } from "@/Git/BlobStore.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("orderedMultipart", () => {
  test("completes with parts in part-number order regardless of settle order", async () => {
    const completed: Array<number[]> = [];
    const upload = orderedMultipart({
      uploadPart: (partNumber, part) =>
        Effect.succeed({ partNumber, size: part.length }),
      complete: (parts) =>
        Effect.sync(() => {
          completed.push(parts.map((p) => p.partNumber));
        }),
      abort: Effect.void,
    });
    // The spill uploads its (small) tail while earlier parts are in flight,
    // so settle order is not part order.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* upload.uploadPart(1, new Uint8Array(8));
        yield* upload.uploadPart(3, new Uint8Array(8));
        yield* upload.uploadPart(6, new Uint8Array(3));
        yield* upload.uploadPart(2, new Uint8Array(8));
        yield* upload.uploadPart(5, new Uint8Array(8));
        yield* upload.uploadPart(4, new Uint8Array(8));
        yield* upload.complete;
      }),
    );
    expect(completed).toEqual([[1, 2, 3, 4, 5, 6]]);
  });
});
