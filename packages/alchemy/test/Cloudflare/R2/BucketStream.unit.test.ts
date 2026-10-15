import type * as runtime from "@cloudflare/workers-types";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeR2ObjectWrappers } from "@/Cloudflare/R2/BucketBinding.ts";
import { R2Error } from "@/Cloudflare/R2/BucketTypes.ts";
import { getRawStream } from "@/Util/Stream.ts";

const tags = ["unit", "provider:cloudflare", "provider:cloudflare:r2", "local"];

// Pure wrapper tests. The deployed copy workload separately checks real R2's
// stream length/ownership and put behavior; this is not a cloud API substitute.
const wrap = (body: ReadableStream<Uint8Array>, nativeStreams = false) => {
  const wrappers = makeR2ObjectWrappers(
    <T>(fn: () => Promise<T>) =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) => new R2Error({ message: "read failed", cause: cause as Error }),
      }),
    nativeStreams,
  );
  const object = wrappers.wrapR2ObjectOrBody({
    body,
    writeHttpMetadata: () => {},
  } as unknown as runtime.R2ObjectBody);
  if (object === null || !("body" in object)) throw new Error("Expected object body");
  return object;
};

const bytes = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });

test.effect(
  "native R2 body preserves an unlocked stream for forwarding",
  () =>
    Effect.sync(() => {
      const raw = bytes();
      const object = wrap(raw, true);
      expect(object.readable).toBe(raw);
      expect(getRawStream(object.body)).toBe(raw);
      expect(raw.locked).toBe(false);
    }),
  { tags },
);

test.effect(
  "R2 body transformations cannot bypass their transformed bytes",
  () =>
    Effect.gen(function* () {
      const object = wrap(bytes(), true);
      const transformed = object.body.pipe(Stream.map((chunk) => chunk.map((byte) => byte + 10)));
      expect(getRawStream(transformed)).toBeUndefined();
      const chunks = yield* Stream.runCollect(transformed);
      expect(Array.from(chunks).flatMap((chunk) => Array.from(chunk))).toEqual([11, 12, 13]);
    }),
  { tags },
);

test.effect(
  "proxy R2 bodies do not acquire native stream provenance",
  () =>
    Effect.gen(function* () {
      const object = wrap(bytes());
      expect(getRawStream(object.body)).toBeUndefined();
      const chunks = yield* Stream.runCollect(object.body);
      expect(Array.from(chunks).flatMap((chunk) => Array.from(chunk))).toEqual([1, 2, 3]);
    }),
  { tags },
);
