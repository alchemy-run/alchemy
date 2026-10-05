import {
  makeQueueSink,
  MAX_BATCH_BYTES,
  MAX_BATCH_MESSAGES,
  messageSize,
  packQueueSinkBatches,
} from "@/Cloudflare/Queues/QueueSinkBatch.ts";
import { SendError, type SendMessage } from "@/Cloudflare/Queues/QueueTypes.ts";
import type { WriteQueueClient } from "@/Cloudflare/Queues/WriteQueue.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

/**
 * Pure tests of the Cloudflare `QueueSink` batching with a fake
 * `WriteQueue` client. Live delivery is covered by `QueueSink.test.ts`.
 */

const fakeClient = (options?: { failOnBatch?: number }) => {
  const batches: SendMessage[][] = [];
  const client: WriteQueueClient = {
    raw: Effect.die("unused"),
    send: () => Effect.die("unused"),
    sendBatch: (messages) =>
      Effect.suspend(() => {
        if (batches.length === options?.failOnBatch) {
          return Effect.fail(new SendError({ message: "rejected" }));
        }
        batches.push([...messages]);
        return Effect.void;
      }),
  };
  return { client, batches };
};

const run = <A>(stream: Stream.Stream<A>, client: WriteQueueClient) =>
  stream.pipe(
    Stream.run(makeQueueSink(client)),
    Effect.provideService(RuntimeContext, {} as never),
  );

describe("Cloudflare QueueSink batching", { tags: ["unit", "local"] }, () => {
  it("packs at most 100 messages per batch, preserving order", () => {
    const bodies = Array.from({ length: 250 }, (_, i) => i);
    const batches = packQueueSinkBatches(bodies);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(bodies);
  });

  it("packs by total size under 256 KB", () => {
    const body = "x".repeat(100_000);
    const batches = packQueueSinkBatches([body, body, body, body, body]);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    for (const batch of batches) {
      const bytes = batch.reduce((sum, b) => sum + messageSize(b), 0);
      expect(bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  it("measures UTF-8 JSON bytes plus per-message overhead", () => {
    expect(messageSize("é")).toBe(4 + 100);
    expect(messageSize({ a: 1 })).toBe(7 + 100);
    expect(messageSize(undefined)).toBe(100);
  });

  it("ships an oversized message alone", () => {
    const huge = "x".repeat(MAX_BATCH_BYTES);
    expect(packQueueSinkBatches(["a", huge, "b"]).map((b) => b.length)).toEqual(
      [1, 1, 1],
    );
  });

  it.effect("sends one sendBatch per chunk", () =>
    Effect.gen(function* () {
      const { client, batches } = fakeClient();
      yield* run(
        Stream.fromIterable([1, 2, 3, 4, 5]).pipe(Stream.rechunk(2)),
        client,
      );
      expect(batches.map((b) => b.map((m) => m.body))).toEqual([
        [1, 2],
        [3, 4],
        [5],
      ]);
    }),
  );

  it.effect("splits an oversized chunk into consecutive batches", () =>
    Effect.gen(function* () {
      const { client, batches } = fakeClient();
      const bodies = Array.from({ length: 250 }, (_, i) => ({ i }));
      yield* run(Stream.fromIterable(bodies), client);
      expect(batches.map((b) => b.length)).toEqual([
        MAX_BATCH_MESSAGES,
        MAX_BATCH_MESSAGES,
        50,
      ]);
      expect(batches.flat().map((m) => m.body)).toEqual(bodies);
    }),
  );

  it.effect("fails the sink with the SendError and stops sending", () =>
    Effect.gen(function* () {
      const { client, batches } = fakeClient({ failOnBatch: 1 });
      const exit = yield* run(
        Stream.fromIterable(Array.from({ length: 250 }, (_, i) => i)),
        client,
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(batches.length).toBe(1);
    }),
  );
});
